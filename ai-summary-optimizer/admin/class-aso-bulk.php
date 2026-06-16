<?php
defined( 'ABSPATH' ) || exit;

class ASO_Bulk {

    public function init(): void {
        foreach ( $this->get_enabled_post_types() as $pt ) {
            add_filter( "bulk_actions-edit-{$pt}", [ $this, 'register_bulk_action' ] );
            add_filter( "handle_bulk_actions-edit-{$pt}", [ $this, 'handle_bulk_action' ], 10, 3 );
        }

        add_action( 'admin_notices', [ $this, 'bulk_action_notice' ] );
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
            is_wp_error( $result ) ? $errors++ : $generated++;
        }

        return add_query_arg( [ 'aso_generated' => $generated, 'aso_errors' => $errors ], $redirect_url );
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
            null,
            __( 'Generate AI Summaries', 'ai-summary-optimizer' ),
            __( 'Generate AI Summaries', 'ai-summary-optimizer' ),
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

        // Fetch all published posts for each enabled post type.
        $all_posts = [];
        foreach ( $post_types as $pt ) {
            $q = new WP_Query( [
                'post_type'      => $pt,
                'post_status'    => 'publish',
                'posts_per_page' => -1,
                'orderby'        => 'title',
                'order'          => 'ASC',
            ] );
            foreach ( $q->posts as $post ) {
                $has_summary = (bool) get_post_meta( $post->ID, ASO_META_KEY, true );
                $all_posts[] = [
                    'id'          => $post->ID,
                    'title'       => $post->post_title ?: '(no title)',
                    'type'        => $pt,
                    'has_summary' => $has_summary,
                    'edit_url'    => get_edit_post_link( $post->ID ),
                ];
            }
        }
        ?>
        <div class="wrap">
            <h1><?php esc_html_e( 'Generate AI Summaries', 'ai-summary-optimizer' ); ?></h1>
            <p><?php esc_html_e( 'Select the posts and pages you want to generate summaries for, then click Generate. Posts that already have a summary are marked — you can re-generate them too.', 'ai-summary-optimizer' ); ?></p>

            <?php if ( empty( $settings['api_key'] ) ) : ?>
                <div class="notice notice-error inline">
                    <p><?php printf(
                        esc_html__( 'No API key configured. %sSet it here%s.', 'ai-summary-optimizer' ),
                        '<a href="' . esc_url( admin_url( 'options-general.php?page=ai-summary-optimizer' ) ) . '">',
                        '</a>'
                    ); ?></p>
                </div>
            <?php endif; ?>

            <?php if ( empty( $all_posts ) ) : ?>
                <p><?php esc_html_e( 'No published posts or pages found.', 'ai-summary-optimizer' ); ?></p>
            <?php else : ?>

            <!-- Toolbar -->
            <div style="margin:16px 0 8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
                <label style="font-weight:600;">
                    <input type="checkbox" id="aso-check-all" />
                    <?php esc_html_e( 'Select All', 'ai-summary-optimizer' ); ?>
                </label>
                <label>
                    <input type="checkbox" id="aso-check-missing" />
                    <?php esc_html_e( 'Select only missing summaries', 'ai-summary-optimizer' ); ?>
                </label>
                <span style="flex:1;"></span>
                <button id="aso-bulk-btn" class="button button-primary" <?php disabled( empty( $settings['api_key'] ) ); ?>>
                    <?php esc_html_e( 'Generate for Selected', 'ai-summary-optimizer' ); ?>
                </button>
                <span id="aso-bulk-spinner" class="spinner" style="float:none;margin:0;vertical-align:middle;display:none;"></span>
            </div>

            <!-- Post table -->
            <table class="wp-list-table widefat fixed striped" id="aso-post-table">
                <thead>
                    <tr>
                        <td class="manage-column column-cb check-column"><input type="checkbox" style="display:none" /></td>
                        <th><?php esc_html_e( 'Title', 'ai-summary-optimizer' ); ?></th>
                        <th style="width:90px;"><?php esc_html_e( 'Type', 'ai-summary-optimizer' ); ?></th>
                        <th style="width:120px;"><?php esc_html_e( 'Summary', 'ai-summary-optimizer' ); ?></th>
                        <th style="width:140px;"><?php esc_html_e( 'Status', 'ai-summary-optimizer' ); ?></th>
                    </tr>
                </thead>
                <tbody>
                    <?php foreach ( $all_posts as $p ) : ?>
                    <tr data-id="<?php echo esc_attr( $p['id'] ); ?>" data-has-summary="<?php echo $p['has_summary'] ? '1' : '0'; ?>">
                        <th class="check-column">
                            <input type="checkbox" class="aso-post-cb" value="<?php echo esc_attr( $p['id'] ); ?>" />
                        </th>
                        <td>
                            <strong><a href="<?php echo esc_url( $p['edit_url'] ); ?>"><?php echo esc_html( $p['title'] ); ?></a></strong>
                        </td>
                        <td><?php echo esc_html( $p['type'] ); ?></td>
                        <td class="aso-has-summary">
                            <?php if ( $p['has_summary'] ) : ?>
                                <span style="color:green;">&#10003; <?php esc_html_e( 'Has summary', 'ai-summary-optimizer' ); ?></span>
                            <?php else : ?>
                                <span style="color:#aaa;">&#8212; <?php esc_html_e( 'None', 'ai-summary-optimizer' ); ?></span>
                            <?php endif; ?>
                        </td>
                        <td class="aso-row-status"></td>
                    </tr>
                    <?php endforeach; ?>
                </tbody>
            </table>

            <!-- Progress bar -->
            <div id="aso-bulk-progress" style="margin-top:16px;display:none;">
                <p id="aso-bulk-status" style="font-weight:600;"></p>
                <progress id="aso-bulk-bar" value="0" max="100" style="width:100%;max-width:600px;height:20px;"></progress>
            </div>

            <?php endif; ?>
        </div>

        <script>
        (function($){
            var nonce = <?php echo wp_json_encode( wp_create_nonce( 'aso_bulk_nonce' ) ); ?>;

            // Select All toggle.
            $('#aso-check-all').on('change', function(){
                $('.aso-post-cb').prop('checked', this.checked);
            });

            // Select only missing.
            $('#aso-check-missing').on('change', function(){
                if (this.checked) {
                    $('#aso-check-all').prop('checked', false);
                    $('.aso-post-cb').each(function(){
                        var hasSummary = $(this).closest('tr').data('has-summary');
                        $(this).prop('checked', hasSummary == '0');
                    });
                } else {
                    $('.aso-post-cb').prop('checked', false);
                }
            });

            // Generate button.
            $('#aso-bulk-btn').on('click', function(){
                var selected = [];
                $('.aso-post-cb:checked').each(function(){
                    selected.push( parseInt($(this).val(), 10) );
                });

                if (!selected.length) {
                    alert('Please select at least one post or page.');
                    return;
                }

                $(this).prop('disabled', true);
                $('#aso-check-all, #aso-check-missing, .aso-post-cb').prop('disabled', true);
                $('#aso-bulk-spinner').show();
                $('#aso-bulk-progress').show();

                var total   = selected.length;
                var current = 0;

                function processNext() {
                    if (current >= total) {
                        $('#aso-bulk-status').text('Done! ' + total + ' post(s) processed.');
                        $('#aso-bulk-spinner').hide();
                        $('#aso-bulk-btn').prop('disabled', false);
                        $('#aso-check-all, #aso-check-missing, .aso-post-cb').prop('disabled', false);
                        return;
                    }

                    var id = selected[current];
                    $('#aso-bulk-status').text('Processing ' + (current + 1) + ' of ' + total + '…');
                    $('#aso-bulk-bar').val(Math.round((current / total) * 100));

                    var $row = $('tr[data-id="' + id + '"]');
                    $row.find('.aso-row-status').html('<em style="color:#888;">Generating…</em>');

                    $.post(ajaxurl, {
                        action:  'aso_bulk_generate',
                        post_id: id,
                        nonce:   nonce
                    }, function(res){
                        if (res.success) {
                            $row.find('.aso-has-summary').html('<span style="color:green;">&#10003; Has summary</span>');
                            $row.find('.aso-row-status').html('<span style="color:green;">&#10003; Done</span>');
                            $row.attr('data-has-summary', '1');
                        } else {
                            var msg = (res.data && res.data.message) ? res.data.message : 'Unknown error';
                            $row.find('.aso-row-status').html('<span style="color:red;">&#10007; ' + $('<span>').text(msg).html() + '</span>');
                        }
                        current++;
                        processNext();
                    }).fail(function(xhr){
                        var rawText = xhr.responseText ? xhr.responseText.substring(0, 200) : 'No response';
                        $row.find('.aso-row-status').html('<span style="color:red;">&#10007; Request failed — check PHP error log. Response: ' + rawText + '</span>');
                        current++;
                        processNext();
                    });
                }

                processNext();
            });
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
