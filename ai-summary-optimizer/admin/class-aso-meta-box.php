<?php
defined( 'ABSPATH' ) || exit;

class ASO_Meta_Box {

    public function init(): void {
        add_action( 'add_meta_boxes', [ $this, 'register_meta_box' ] );
        add_action( 'save_post', [ $this, 'save_meta_box' ] );
        add_action( 'admin_footer', [ $this, 'print_script' ] );
    }

    public function register_meta_box(): void {
        $settings    = get_option( 'aso_settings', [] );
        $post_types  = $settings['post_types'] ?? [ 'post', 'page' ];

        foreach ( (array) $post_types as $pt ) {
            add_meta_box(
                'aso-meta-box',
                __( 'AI Summary Optimizer', 'ai-summary-optimizer' ),
                [ $this, 'render_meta_box' ],
                $pt,
                'normal',
                'high'
            );
        }
    }

    public function render_meta_box( WP_Post $post ): void {
        wp_nonce_field( 'aso_save_meta_' . $post->ID, 'aso_meta_nonce' );

        $summary      = get_post_meta( $post->ID, ASO_META_KEY, true );
        $enabled      = get_post_meta( $post->ID, ASO_META_ENABLED, true );
        $generated_at = get_post_meta( $post->ID, '_aso_generated_at', true );
        $is_enabled   = ( $enabled !== '0' ); // default on
        ?>
        <div id="aso-meta-box">
            <p>
                <label>
                    <input type="checkbox" name="aso_post_enabled" value="1" <?php checked( $is_enabled ); ?> />
                    <?php esc_html_e( 'Show AI summary on this post/page', 'ai-summary-optimizer' ); ?>
                </label>
            </p>

            <?php if ( $summary ) : ?>
                <div class="aso-summary-preview"><?php echo esc_html( $summary ); ?></div>
                <?php if ( $generated_at ) : ?>
                    <p class="description"><?php printf( esc_html__( 'Last generated: %s', 'ai-summary-optimizer' ), esc_html( $generated_at ) ); ?></p>
                <?php endif; ?>
            <?php else : ?>
                <p class="description"><?php esc_html_e( 'No summary generated yet.', 'ai-summary-optimizer' ); ?></p>
            <?php endif; ?>

            <p>
                <button type="button" id="aso-generate-btn" class="button button-primary"
                        data-post-id="<?php echo esc_attr( $post->ID ); ?>"
                        data-nonce="<?php echo esc_attr( wp_create_nonce( 'aso_generate_nonce' ) ); ?>">
                    <?php echo $summary ? esc_html__( 'Regenerate Summary', 'ai-summary-optimizer' ) : esc_html__( 'Generate Summary', 'ai-summary-optimizer' ); ?>
                </button>
                <span id="aso-spinner" class="spinner" style="float:none;margin-top:0;vertical-align:middle;display:none;"></span>
                <span id="aso-status" style="margin-left:6px;"></span>
            </p>

            <?php if ( $summary ) : ?>
                <p>
                    <label for="aso_summary_edit"><strong><?php esc_html_e( 'Edit Summary (optional):', 'ai-summary-optimizer' ); ?></strong></label><br />
                    <textarea id="aso_summary_edit" name="aso_summary_edit" rows="4" style="width:100%;"><?php echo esc_textarea( $summary ); ?></textarea>
                    <span class="description"><?php esc_html_e( 'Changes here are saved when you update the post.', 'ai-summary-optimizer' ); ?></span>
                </p>
            <?php endif; ?>
        </div>
        <?php
    }

    public function save_meta_box( int $post_id ): void {
        if ( ! isset( $_POST['aso_meta_nonce'] ) ) {
            return;
        }
        if ( ! wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['aso_meta_nonce'] ) ), 'aso_save_meta_' . $post_id ) ) {
            return;
        }
        if ( defined( 'DOING_AUTOSAVE' ) && DOING_AUTOSAVE ) {
            return;
        }
        if ( ! current_user_can( 'edit_post', $post_id ) ) {
            return;
        }

        // Per-post enable/disable.
        $enabled = ! empty( $_POST['aso_post_enabled'] ) ? '1' : '0';
        update_post_meta( $post_id, ASO_META_ENABLED, $enabled );

        // Manual summary edit.
        if ( isset( $_POST['aso_summary_edit'] ) ) {
            $edited = sanitize_textarea_field( wp_unslash( $_POST['aso_summary_edit'] ) );
            if ( ! empty( $edited ) ) {
                update_post_meta( $post_id, ASO_META_KEY, $edited );
            }
        }
    }

    public function print_script(): void {
        $screen = get_current_screen();
        if ( ! $screen || ! in_array( $screen->base, [ 'post', 'page' ], true ) ) {
            return;
        }
        ?>
        <script>
        (function($){
            $('#aso-generate-btn').on('click', function(){
                var btn    = $(this);
                var postId = btn.data('post-id');
                var nonce  = btn.data('nonce');

                btn.prop('disabled', true);
                $('#aso-spinner').show();
                $('#aso-status').text('');

                $.post(ajaxurl, {
                    action:  'aso_generate_single',
                    post_id: postId,
                    nonce:   nonce
                }, function(res){
                    if (res.success) {
                        var s = res.data.summary;
                        // Update preview box.
                        if ($('.aso-summary-preview').length) {
                            $('.aso-summary-preview').text(s);
                        } else {
                            $('<div class="aso-summary-preview"></div>').text(s).insertBefore('#aso-generate-btn').closest('p');
                        }
                        // Update textarea if present.
                        if ($('#aso_summary_edit').length) {
                            $('#aso_summary_edit').val(s);
                        } else {
                            // Inject textarea after button paragraph.
                            var ta = $('<p><label for="aso_summary_edit"><strong>Edit Summary (optional):</strong></label><br />'
                                + '<textarea id="aso_summary_edit" name="aso_summary_edit" rows="4" style="width:100%;"></textarea></p>');
                            ta.find('textarea').val(s);
                            ta.insertAfter(btn.closest('p'));
                        }
                        btn.text('Regenerate Summary');
                        $('#aso-status').css('color','green').text('Summary generated!');
                    } else {
                        $('#aso-status').css('color','red').text(res.data.message || 'An error occurred.');
                    }
                }).fail(function(){
                    $('#aso-status').css('color','red').text('Request failed. Please try again.');
                }).always(function(){
                    btn.prop('disabled', false);
                    $('#aso-spinner').hide();
                });
            });
        })(jQuery);
        </script>
        <?php
    }
}
