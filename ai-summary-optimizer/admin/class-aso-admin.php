<?php
defined( 'ABSPATH' ) || exit;

class ASO_Admin {

    public function init(): void {
        add_action( 'admin_menu', [ $this, 'add_menu' ] );
        add_action( 'admin_init', [ $this, 'register_settings' ] );
        add_action( 'admin_enqueue_scripts', [ $this, 'enqueue_styles' ] );
        add_action( 'wp_ajax_aso_generate_single', [ $this, 'ajax_generate_single' ] );
        add_action( 'wp_ajax_aso_test_connection', [ $this, 'ajax_test_connection' ] );
    }

    public function add_menu(): void {
        add_options_page(
            __( 'AI Summary Optimizer', 'ai-summary-optimizer' ),
            __( 'AI Summary Optimizer', 'ai-summary-optimizer' ),
            'manage_options',
            'ai-summary-optimizer',
            [ $this, 'render_settings_page' ]
        );
    }

    public function enqueue_styles( string $hook ): void {
        if ( ! in_array( $hook, [ 'settings_page_ai-summary-optimizer', 'post.php', 'post-new.php' ], true ) ) {
            return;
        }
        wp_add_inline_style( 'wp-admin', $this->inline_css() );
    }

    private function inline_css(): string {
        return '
.aso-summary { background: #f0f6fc; border-left: 4px solid #0073aa; padding: 14px 18px; margin: 0 0 1.5em; border-radius: 3px; }
.aso-label { margin: 0 0 6px; font-size: .8em; text-transform: uppercase; letter-spacing: .04em; color: #555; }
.aso-summary-text { margin: 0; line-height: 1.6; }
#aso-meta-box .aso-summary-preview { background:#f9f9f9; border:1px solid #ddd; padding:10px; border-radius:3px; margin-bottom:10px; font-size:13px; line-height:1.6; }
#aso-meta-box .button { margin-right:6px; }
        ';
    }

    public function register_settings(): void {
        register_setting( 'aso_settings_group', 'aso_settings', [
            'sanitize_callback' => [ $this, 'sanitize_settings' ],
        ] );
    }

    public function sanitize_settings( $input ): array {
        $clean = [];
        $clean['api_key']    = sanitize_text_field( $input['api_key'] ?? '' );
        $clean['enabled']    = ! empty( $input['enabled'] ) ? '1' : '0';
        $clean['post_types'] = array_map( 'sanitize_key', (array) ( $input['post_types'] ?? [] ) );
        $clean['style']      = in_array( $input['style'] ?? '', [ 'concise', 'detailed', 'bullet', 'seo_friendly' ], true )
                               ? $input['style'] : 'concise';
        $clean['max_words']  = absint( $input['max_words'] ?? 80 );
        $clean['show_label'] = ! empty( $input['show_label'] ) ? '1' : '0';
        $clean['label_text'] = sanitize_text_field( $input['label_text'] ?? 'AI Summary' );
        return $clean;
    }

    public function render_settings_page(): void {
        if ( ! current_user_can( 'manage_options' ) ) {
            return;
        }
        $settings    = get_option( 'aso_settings', [] );
        $post_types  = get_post_types( [ 'public' => true ], 'objects' );
        $saved_types = $settings['post_types'] ?? [ 'post', 'page' ];
        ?>
        <div class="wrap">
            <h1><?php esc_html_e( 'AI Summary Optimizer', 'ai-summary-optimizer' ); ?></h1>
            <p><?php esc_html_e( 'Generates AI-powered summaries via the Claude API and prepends them to your content to improve AI platform rankings.', 'ai-summary-optimizer' ); ?></p>

            <form method="post" action="options.php">
                <?php settings_fields( 'aso_settings_group' ); ?>

                <table class="form-table" role="presentation">
                    <tr>
                        <th scope="row"><label for="aso_api_key"><?php esc_html_e( 'Anthropic API Key', 'ai-summary-optimizer' ); ?></label></th>
                        <td>
                            <input type="password" id="aso_api_key" name="aso_settings[api_key]"
                                   value="<?php echo esc_attr( $settings['api_key'] ?? '' ); ?>"
                                   class="regular-text" autocomplete="off" />
                            <p class="description"><?php esc_html_e( 'Get your key at console.anthropic.com.', 'ai-summary-optimizer' ); ?></p>
                            <p>
                                <button type="button" id="aso-test-btn" class="button button-secondary" style="margin-top:6px;">
                                    <?php esc_html_e( 'Test API Connection', 'ai-summary-optimizer' ); ?>
                                </button>
                                <span id="aso-test-result" style="margin-left:10px;font-weight:600;"></span>
                            </p>
                            <script>
                            (function($){
                                $('#aso-test-btn').on('click', function(){
                                    var key = $('#aso_api_key').val();
                                    if (!key) { alert('Enter your API key first.'); return; }
                                    $(this).prop('disabled', true).text('Testing…');
                                    $('#aso-test-result').css('color','').text('');
                                    $.post(ajaxurl, {
                                        action: 'aso_test_connection',
                                        nonce:  <?php echo wp_json_encode( wp_create_nonce( 'aso_test_nonce' ) ); ?>,
                                        api_key: key
                                    }, function(res){
                                        if (res.success) {
                                            $('#aso-test-result').css('color','green').text('✓ Connected! ' + res.data.message);
                                        } else {
                                            $('#aso-test-result').css('color','red').text('✗ ' + (res.data.message || 'Connection failed'));
                                        }
                                    }).fail(function(){ $('#aso-test-result').css('color','red').text('✗ Request failed.'); })
                                    .always(function(){ $('#aso-test-btn').prop('disabled', false).text('Test API Connection'); });
                                });
                            })(jQuery);
                            </script>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><?php esc_html_e( 'Enable Plugin', 'ai-summary-optimizer' ); ?></th>
                        <td>
                            <label>
                                <input type="checkbox" name="aso_settings[enabled]" value="1"
                                       <?php checked( $settings['enabled'] ?? '1', '1' ); ?> />
                                <?php esc_html_e( 'Display summaries on the front end', 'ai-summary-optimizer' ); ?>
                            </label>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><?php esc_html_e( 'Post Types', 'ai-summary-optimizer' ); ?></th>
                        <td>
                            <?php foreach ( $post_types as $pt ) : ?>
                                <label style="display:block;margin-bottom:4px;">
                                    <input type="checkbox" name="aso_settings[post_types][]"
                                           value="<?php echo esc_attr( $pt->name ); ?>"
                                           <?php checked( in_array( $pt->name, $saved_types, true ) ); ?> />
                                    <?php echo esc_html( $pt->label ); ?>
                                </label>
                            <?php endforeach; ?>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="aso_style"><?php esc_html_e( 'Summary Style', 'ai-summary-optimizer' ); ?></label></th>
                        <td>
                            <select id="aso_style" name="aso_settings[style]">
                                <option value="concise"      <?php selected( $settings['style'] ?? 'concise', 'concise' ); ?>><?php esc_html_e( 'Concise (2-3 sentences)', 'ai-summary-optimizer' ); ?></option>
                                <option value="detailed"     <?php selected( $settings['style'] ?? 'concise', 'detailed' ); ?>><?php esc_html_e( 'Detailed (4-5 sentences)', 'ai-summary-optimizer' ); ?></option>
                                <option value="bullet"       <?php selected( $settings['style'] ?? 'concise', 'bullet' ); ?>><?php esc_html_e( 'Bullet Points (3-5 key takeaways)', 'ai-summary-optimizer' ); ?></option>
                                <option value="seo_friendly" <?php selected( $settings['style'] ?? 'concise', 'seo_friendly' ); ?>><?php esc_html_e( 'SEO-Friendly (keyword-rich)', 'ai-summary-optimizer' ); ?></option>
                            </select>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="aso_max_words"><?php esc_html_e( 'Max Words', 'ai-summary-optimizer' ); ?></label></th>
                        <td>
                            <input type="number" id="aso_max_words" name="aso_settings[max_words]"
                                   value="<?php echo esc_attr( $settings['max_words'] ?? 80 ); ?>"
                                   min="20" max="300" class="small-text" />
                        </td>
                    </tr>
                    <tr>
                        <th scope="row"><?php esc_html_e( 'Summary Label', 'ai-summary-optimizer' ); ?></th>
                        <td>
                            <label>
                                <input type="checkbox" name="aso_settings[show_label]" value="1"
                                       <?php checked( $settings['show_label'] ?? '1', '1' ); ?> />
                                <?php esc_html_e( 'Show label above summary', 'ai-summary-optimizer' ); ?>
                            </label>
                            <br /><br />
                            <input type="text" name="aso_settings[label_text]"
                                   value="<?php echo esc_attr( $settings['label_text'] ?? 'AI Summary' ); ?>"
                                   class="regular-text" placeholder="AI Summary" />
                            <p class="description"><?php esc_html_e( 'Text shown above the summary box.', 'ai-summary-optimizer' ); ?></p>
                        </td>
                    </tr>
                </table>

                <?php submit_button(); ?>
            </form>

            <hr />
            <h2><?php esc_html_e( 'Bulk Generate Summaries', 'ai-summary-optimizer' ); ?></h2>
            <p><?php esc_html_e( 'Use the Posts or Pages list screen and select "Generate AI Summary" from the Bulk Actions dropdown, or visit the dedicated bulk tool below.', 'ai-summary-optimizer' ); ?></p>
            <a href="<?php echo esc_url( admin_url( 'admin.php?page=aso-bulk-generate' ) ); ?>" class="button button-secondary">
                <?php esc_html_e( 'Open Bulk Generator', 'ai-summary-optimizer' ); ?>
            </a>
        </div>
        <?php
    }

    /** AJAX: test the API key by sending a minimal request to Anthropic. */
    public function ajax_test_connection(): void {
        check_ajax_referer( 'aso_test_nonce', 'nonce' );

        if ( ! current_user_can( 'manage_options' ) ) {
            wp_send_json_error( [ 'message' => 'Permission denied.' ] );
        }

        $api_key = sanitize_text_field( wp_unslash( $_POST['api_key'] ?? '' ) );
        if ( empty( $api_key ) ) {
            wp_send_json_error( [ 'message' => 'No API key provided.' ] );
        }

        $response = wp_remote_post( 'https://api.anthropic.com/v1/messages', [
            'timeout' => 20,
            'headers' => [
                'Content-Type'      => 'application/json',
                'x-api-key'         => $api_key,
                'anthropic-version' => '2023-06-01',
            ],
            'body' => wp_json_encode( [
                'model'      => 'claude-opus-4-8',
                'max_tokens' => 10,
                'messages'   => [ [ 'role' => 'user', 'content' => 'Say OK' ] ],
            ] ),
        ] );

        if ( is_wp_error( $response ) ) {
            wp_send_json_error( [ 'message' => 'WordPress HTTP error: ' . $response->get_error_message() ] );
        }

        $code = wp_remote_retrieve_response_code( $response );
        $data = json_decode( wp_remote_retrieve_body( $response ), true );

        if ( $code === 200 ) {
            wp_send_json_success( [ 'message' => 'API key is valid and Claude responded successfully.' ] );
        }

        $error_msg = $data['error']['message'] ?? ( 'HTTP ' . $code );
        wp_send_json_error( [ 'message' => $error_msg ] );
    }

    /** AJAX: generate summary for a single post from the meta box. */
    public function ajax_generate_single(): void {
        check_ajax_referer( 'aso_generate_nonce', 'nonce' );

        if ( ! current_user_can( 'edit_posts' ) ) {
            wp_send_json_error( [ 'message' => __( 'Permission denied.', 'ai-summary-optimizer' ) ] );
        }

        $post_id = absint( $_POST['post_id'] ?? 0 );
        if ( ! $post_id ) {
            wp_send_json_error( [ 'message' => __( 'Invalid post ID.', 'ai-summary-optimizer' ) ] );
        }

        $result = aso_generate_and_save( $post_id );

        if ( is_wp_error( $result ) ) {
            wp_send_json_error( [ 'message' => $result->get_error_message() ] );
        }

        wp_send_json_success( [ 'summary' => $result ] );
    }
}

/**
 * Shared helper: generate a summary for a post and save it to meta.
 *
 * @return string|WP_Error  The summary text or an error.
 */
function aso_generate_and_save( int $post_id ) {
    $post = get_post( $post_id );
    if ( ! $post ) {
        return new WP_Error( 'aso_not_found', __( 'Post not found.', 'ai-summary-optimizer' ) );
    }

    $settings = get_option( 'aso_settings', [] );
    $api_key  = $settings['api_key'] ?? '';

    if ( empty( $api_key ) ) {
        return new WP_Error( 'aso_no_key', __( 'Anthropic API key is not set. Configure it under Settings → AI Summary Optimizer.', 'ai-summary-optimizer' ) );
    }

    // Strip shortcodes and HTML for cleaner input.
    $content = wp_strip_all_tags( do_shortcode( $post->post_content ) );
    $content = trim( $content );

    if ( strlen( $content ) < 50 ) {
        return new WP_Error( 'aso_short', __( 'Post content is too short to summarize.', 'ai-summary-optimizer' ) );
    }

    // Truncate to ~8000 chars to stay well within token limits.
    if ( strlen( $content ) > 8000 ) {
        $content = substr( $content, 0, 8000 ) . '…';
    }

    $api     = new ASO_API( $api_key );
    $summary = $api->generate_summary( $content, $settings );

    if ( is_wp_error( $summary ) ) {
        return $summary;
    }

    update_post_meta( $post_id, ASO_META_KEY, $summary );
    update_post_meta( $post_id, '_aso_generated_at', current_time( 'mysql' ) );

    return $summary;
}
