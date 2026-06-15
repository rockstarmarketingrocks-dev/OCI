<?php
/**
 * Plugin Name: AI Summary Optimizer
 * Plugin URI:  https://github.com/rockstarmarketingrocks-dev/oci
 * Description: Automatically generates AI-powered summaries for your pages and posts to improve visibility on AI platforms (AIO/GEO optimization). Summaries are prepended before the first paragraph of each page.
 * Version:     1.0.0
 * Author:      Rockstar Marketing
 * License:     GPL-2.0-or-later
 * Text Domain: ai-summary-optimizer
 */

defined( 'ABSPATH' ) || exit;

define( 'ASO_VERSION', '1.0.0' );
define( 'ASO_FILE', __FILE__ );
define( 'ASO_DIR', plugin_dir_path( __FILE__ ) );
define( 'ASO_URL', plugin_dir_url( __FILE__ ) );
define( 'ASO_META_KEY', '_aso_summary' );
define( 'ASO_META_ENABLED', '_aso_enabled' );

require_once ASO_DIR . 'includes/class-aso-api.php';
require_once ASO_DIR . 'includes/class-aso-content.php';
require_once ASO_DIR . 'admin/class-aso-admin.php';
require_once ASO_DIR . 'admin/class-aso-meta-box.php';
require_once ASO_DIR . 'admin/class-aso-bulk.php';

function aso_init() {
    ( new ASO_Content() )->init();

    if ( is_admin() ) {
        ( new ASO_Admin() )->init();
        ( new ASO_Meta_Box() )->init();
        ( new ASO_Bulk() )->init();
    }
}
add_action( 'plugins_loaded', 'aso_init' );

register_activation_hook( __FILE__, 'aso_activate' );
function aso_activate() {
    if ( ! get_option( 'aso_settings' ) ) {
        update_option( 'aso_settings', [
            'api_key'      => '',
            'enabled'      => '1',
            'post_types'   => [ 'post', 'page' ],
            'style'        => 'concise',
            'max_words'    => 80,
            'show_label'   => '1',
            'label_text'   => 'AI Summary',
        ] );
    }
}
