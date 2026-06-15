<?php
defined( 'ABSPATH' ) || exit;

class ASO_Bulk {

    public function init(): void {
        // Bulk action on Posts list table.
        foreach ( $this->get_enabled_post_types() as $pt ) {
            add_filter( "bulk_actions-edit-{$pt}", [ $this, 'register_bulk_action' ] );
            add_filter( "handle_bulk_actions-edit-{$pt}", [ $this, 'handle_bulk_action' ], 10, 3 );
        }

        add_action( 'admin_notices', [ $this, 'bulk_action_notice' ] );

        // Dedicated bulk-generate admin page.
        add_action( 'admin_menu', [ $this, 'add_bulk_page' ] );
        add_action( 'wp_ajax_aso_bulk_generate', [ $this, 'ajax_bulk_generate' ] );
    }

    private function get_enabled_post_types(): array {
        $settings = get_option( 'aso_settings', [] );
        return (array) ( $settings['post_types'] ?? [ 'post', 'page' ] );
    }

    public function register_bulk_action( array $bulk_actions ): array {
        $bulk_actions['aso_generate_summary'] = __( 'Generate AI Summary', 'ai-summary-optimizer' );
        return $bulk_actions;
    }

    public function handle_bulk_action( string $redirect_url, string $action, array $post_ids ): string {
        if ( $action !== 'aso_generate_summary' ) {
            return $redirect_url;
        }

        $generated = 0;
        $errors    = 0;

        foreach ( $post_ids as $post_id ) {
            $result = aso_generate_and_save( (int) $post_id );
            if ( is_wp_error( $result ) ) {
                $errors++;
            } else {
                $generated++;
            }
        }

        $redirect_url = add_query_arg( [
            'aso_generated' => $generated,
            'aso_errors'    => $errors,
        ], $redirect_url );

        return $redirect_url;
    }

    public function bulk_action_notice(): void {
        if ( isset( $_GET['aso_generated'] ) ) {
            $generated = absint( $_GET['aso_generated'] );
            $errors    = absint( $_GET['aso_errors'] ?? 0 );
            printf(
                '<div class="notice notice-success is-dismissible"><p>%s</p></div>',
                sprintf(
                    esc_html( _n( '%d AI summary generated.', '%d AI summaries generated.', $generated, 'ai-summary-optimizer' ) ),
                    $generated
                ) . ( $errors ? ' ' . sprintf( esc_html__( '%d failed.', 'ai-summary-optimizer' ), $errors ) : '' )
            );
        }
    }

    public function add_bulk_page(): void {
        add_submenu_page(
            null, // Hidden from menus; accessed via direct URL.
            __( 'Bulk Generate AI Summaries', 'ai-summary-optimizer' ),
            __( 'Bulk Generate', 'ai-summary-optimizer' ),
            'manage_options',
            'aso-bulk-generate',
            [ $this, 'render_bulk_page' ]
        );
    }

    public function render_bulk_page(): void {
        if ( ! current_user_can( 'manage_options' ) ) {
            return;
        }

        $settings   = get_option( 'aso_settings', [] );
        $post_types = $this->get_enabled_post_types();

        // Count posts without summaries per type.
        $counts = [];
        foreach ( $post_types as $pt ) {
            $query = new WP_Query( [
                'post_type'      => $pt,
                'post_status'    => 'publish',
                'posts_per_page' => -1,
                'fields'         => 'ids',
                'meta_query'     => [
                    [
                        'key'     => ASO_META_KEY,
                        'compare' => 'NOT EXISTS',
                    ],
                ],
            ] );
            $counts[ $pt ] = $query->found_posts;
        }
        ?>
        <div class="wrap">
            <h1><?php esc_html_e( 'Bulk Generate AI Summaries', 'ai-summary-optimizer' ); ?></h1>
            <p><?php esc_html_e( 'Click the button below to generate summaries for all published posts that do not yet have one. Already-generated summaries are skipped.', 'ai-summary-optimizer' ); ?></p>

            <?php if ( empty( $settings['api_key'] ) ) : ?>
                <div class="notice notice-error">
                    <p><?php printf(
                        esc_html__( 'No API key configured. %sSet it here%s.', 'ai-summary-optimizer' ),
                        '<a href="' . esc_url( admin_url( 'options-general.php?page=ai-summary-optimizer' ) ) . '">',
                        '</a>'
                    ); ?></p>
                </div>
            <?php endif; ?>

            <table class="widefat" style="max-width:500px;margin-bottom:20px;">
                <thead>
                    <tr><th><?php esc_html_e( 'Post Type', 'ai-summary-optimizer' ); ?></th><th><?php esc_html_e( 'Missing Summaries', 'ai-summary-optimizer' ); ?></th></tr>
                </thead>
                <tbody>
                    <?php foreach ( $counts as $pt => $count ) : ?>
                        <tr><td><?php echo esc_html( $pt ); ?></td><td><?php echo esc_html( $count ); ?></td></tr>
                    <?php endforeach; ?>
                </tbody>
            </table>

            <button id="aso-bulk-btn" class="button button-primary" <?php disabled( empty( $settings['api_key'] ) ); ?>>
                <?php esc_html_e( 'Start Bulk Generation', 'ai-summary-optimizer' ); ?>
            </button>
            <span id="aso-bulk-spinner" class="spinner" style="float:none;margin-top:0;vertical-align:middle;display:none;"></span>

            <div id="aso-bulk-progress" style="margin-top:20px;display:none;">
                <p id="aso-bulk-status"></p>
                <progress id="aso-bulk-bar" value="0" max="100" style="width:400px;"></progress>
                <ul id="aso-bulk-log" style="max-height:200px;overflow-y:auto;background:#f9f9f9;border:1px solid #ddd;padding:10px;margin-top:10px;font-size:12px;"></ul>
            </div>
        </div>

        <script>
        (function($){
            var postIds = <?php
                $all_ids = [];
                foreach ( $post_types as $pt ) {
                    $q = new WP_Query( [
                        'post_type'      => $pt,
                        'post_status'    => 'publish',
                        'posts_per_page' => -1,
                        'fields'         => 'ids',
                        'meta_query'     => [ [ 'key' => '_aso_summary', 'compare' => 'NOT EXISTS' ] ],
                    ] );
                    $all_ids = array_merge( $all_ids, $q->posts );
                }
                echo wp_json_encode( array_map( 'intval', $all_ids ) );
            ?>;

            var nonce   = <?php echo wp_json_encode( wp_create_nonce( 'aso_bulk_nonce' ) ); ?>;
            var total   = postIds.length;
            var current = 0;

            $('#aso-bulk-btn').on('click', function(){
                if (!total) { alert('No posts need summaries!'); return; }
                $(this).prop('disabled', true);
                $('#aso-bulk-spinner').show();
                $('#aso-bulk-progress').show();
                processNext();
            });

            function processNext() {
                if (current >= total) {
                    $('#aso-bulk-status').text('Done! ' + total + ' summaries processed.');
                    $('#aso-bulk-spinner').hide();
                    return;
                }

                var id = postIds[current];
                $('#aso-bulk-status').text('Processing ' + (current + 1) + ' of ' + total + '…');
                $('#aso-bulk-bar').val(Math.round((current / total) * 100));

                $.post(ajaxurl, {
                    action:  'aso_bulk_generate',
                    post_id: id,
                    nonce:   nonce
                }, function(res){
                    var li = $('<li>');
                    if (res.success) {
                        li.css('color','green').text('✓ Post #' + id + ' — ' + res.data.summary.substring(0, 80) + '…');
                    } else {
                        li.css('color','red').text('✗ Post #' + id + ' — ' + (res.data.message || 'Error'));
                    }
                    $('#aso-bulk-log').append(li);
                    current++;
                    processNext();
                }).fail(function(){
                    $('<li>').css('color','orange').text('⚠ Post #' + id + ' — Request failed, skipping.').appendTo('#aso-bulk-log');
                    current++;
                    processNext();
                });
            }
        })(jQuery);
        </script>
        <?php
    }

    public function ajax_bulk_generate(): void {
        check_ajax_referer( 'aso_bulk_nonce', 'nonce' );

        if ( ! current_user_can( 'manage_options' ) ) {
            wp_send_json_error( [ 'message' => 'Permission denied.' ] );
        }

        $post_id = absint( $_POST['post_id'] ?? 0 );
        $result  = aso_generate_and_save( $post_id );

        if ( is_wp_error( $result ) ) {
            wp_send_json_error( [ 'message' => $result->get_error_message() ] );
        }

        wp_send_json_success( [ 'summary' => $result ] );
    }
}
