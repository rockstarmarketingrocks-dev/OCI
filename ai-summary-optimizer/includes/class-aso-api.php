<?php
defined( 'ABSPATH' ) || exit;

class ASO_API {

    const API_URL = 'https://api.anthropic.com/v1/messages';
    const MODEL   = 'claude-opus-4-8';

    private string $api_key;

    public function __construct( string $api_key ) {
        $this->api_key = $api_key;
    }

    /**
     * Generate a summary for the given content.
     *
     * @param  string $content   Raw post content (HTML stripped).
     * @param  array  $settings  Plugin settings array.
     * @return string|WP_Error   Generated summary text or WP_Error on failure.
     */
    public function generate_summary( string $content, array $settings ) {
        if ( empty( $this->api_key ) ) {
            return new WP_Error( 'aso_no_key', __( 'Anthropic API key is not configured.', 'ai-summary-optimizer' ) );
        }

        $style_map = [
            'concise'      => 'Write a concise, factual 2-3 sentence summary.',
            'detailed'     => 'Write a detailed 4-5 sentence summary covering the main points.',
            'bullet'       => 'Write a summary as 3-5 bullet points covering the key takeaways.',
            'seo_friendly' => 'Write a 2-3 sentence summary optimised for search engines, naturally including relevant keywords from the content.',
        ];

        $style_instruction = $style_map[ $settings['style'] ?? 'concise' ] ?? $style_map['concise'];
        $max_words         = absint( $settings['max_words'] ?? 80 );

        $prompt = <<<PROMPT
You are an expert content summarizer helping web pages rank better in AI-powered search platforms.

{$style_instruction} Keep the summary under {$max_words} words. Write in third person, present tense. Do not start with "This page", "This article", or "This post". Return ONLY the summary text — no preamble, no labels, no markdown formatting.

CONTENT TO SUMMARIZE:
{$content}
PROMPT;

        $body = wp_json_encode( [
            'model'      => self::MODEL,
            'max_tokens' => 512,
            'messages'   => [
                [
                    'role'    => 'user',
                    'content' => $prompt,
                ],
            ],
        ] );

        $response = wp_remote_post( self::API_URL, [
            'timeout' => 60,
            'headers' => [
                'Content-Type'      => 'application/json',
                'x-api-key'         => $this->api_key,
                'anthropic-version' => '2023-06-01',
            ],
            'body' => $body,
        ] );

        if ( is_wp_error( $response ) ) {
            return $response;
        }

        $code = wp_remote_retrieve_response_code( $response );
        $data = json_decode( wp_remote_retrieve_body( $response ), true );

        if ( $code !== 200 ) {
            $message = $data['error']['message'] ?? sprintf( 'HTTP %d from Anthropic API', $code );
            return new WP_Error( 'aso_api_error', $message );
        }

        // Extract the first text block (skip thinking blocks).
        $summary = '';
        foreach ( $data['content'] ?? [] as $block ) {
            if ( $block['type'] === 'text' ) {
                $summary = trim( $block['text'] );
                break;
            }
        }

        if ( empty( $summary ) ) {
            return new WP_Error( 'aso_empty', __( 'API returned an empty summary.', 'ai-summary-optimizer' ) );
        }

        return $summary;
    }
}
