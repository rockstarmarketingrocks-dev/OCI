<?php
defined( 'ABSPATH' ) || exit;

class ASO_Content {

    public function init(): void {
        add_filter( 'the_content', [ $this, 'prepend_summary' ], 20 );
    }

    public function prepend_summary( string $content ): string {
        if ( ! is_singular() || is_admin() ) {
            return $content;
        }

        $settings = get_option( 'aso_settings', [] );

        // Plugin-level kill switch.
        if ( empty( $settings['enabled'] ) ) {
            return $content;
        }

        $post_id = get_the_ID();
        if ( ! $post_id ) {
            return $content;
        }

        // Post-level kill switch.
        $post_enabled = get_post_meta( $post_id, ASO_META_ENABLED, true );
        if ( $post_enabled === '0' ) {
            return $content;
        }

        // Only run on configured post types.
        $allowed_types = $settings['post_types'] ?? [ 'post', 'page' ];
        if ( ! in_array( get_post_type( $post_id ), (array) $allowed_types, true ) ) {
            return $content;
        }

        $summary = get_post_meta( $post_id, ASO_META_KEY, true );
        if ( empty( $summary ) ) {
            return $content;
        }

        $show_label = ! empty( $settings['show_label'] );
        $label_text = sanitize_text_field( $settings['label_text'] ?? 'AI Summary' );

        $label_html = $show_label
            ? '<p class="aso-label"><strong>' . esc_html( $label_text ) . '</strong></p>'
            : '';

        $summary_html = sprintf(
            '<div class="aso-summary">%s<p class="aso-summary-text">%s</p></div>',
            $label_html,
            nl2br( esc_html( $summary ) )
        );

        // Insert before the first <p> tag; fall back to prepending.
        if ( str_contains( $content, '<p' ) ) {
            return preg_replace( '/<p[^>]*>/i', $summary_html . '$0', $content, 1 );
        }

        return $summary_html . $content;
    }
}
