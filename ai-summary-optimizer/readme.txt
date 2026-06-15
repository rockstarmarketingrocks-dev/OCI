=== AI Summary Optimizer ===
Contributors: rockstarmarketing
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 8.1
Stable tag: 1.0.0
License: GPL-2.0-or-later

Generates AI-powered summaries via the Claude API and prepends them to your content to improve visibility on AI search platforms.

== Description ==

AI Summary Optimizer analyses the content of every post and page on your WordPress site and generates a concise, accurate summary using Anthropic's Claude API (claude-opus-4-8). The summary is automatically displayed before the first paragraph of each piece of content, helping your pages rank better on AI-powered search platforms (AIO/GEO).

**Features:**

* Generates summaries with Anthropic Claude (claude-opus-4-8)
* Four summary styles: Concise, Detailed, Bullet Points, SEO-Friendly
* Summaries cached in post meta — no API call on every page load
* Per-post enable/disable toggle in the meta box
* One-click generate/regenerate from the post editor
* Manual summary editing from the meta box
* Plugin-level on/off switch with post-type selection
* Bulk generator for all published posts (one at a time, with live progress)
* Bulk action on Posts/Pages list screen
* Configurable label text and max word count

== Installation ==

1. Upload the `ai-summary-optimizer` folder to `/wp-content/plugins/`.
2. Activate the plugin through the Plugins screen.
3. Go to **Settings → AI Summary Optimizer** and enter your Anthropic API key.
4. Choose your preferred summary style and post types.
5. Open any post or page and click **Generate Summary** in the AI Summary Optimizer meta box.

== Frequently Asked Questions ==

= Where do I get an Anthropic API key? =
Sign up at console.anthropic.com and create an API key under your account settings.

= Will generating summaries cost money? =
Yes — each summary requires one API call to Anthropic. Summaries are cached in post meta, so the API is only called when you explicitly generate or regenerate a summary.

= Can I edit the generated summary? =
Yes. After generation a textarea appears in the meta box where you can edit the summary before saving the post.

== Changelog ==

= 1.0.0 =
* Initial release.
