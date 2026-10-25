# Implementation rules – Rockstar Marketing SEO changes (2026-10-25)

The user asked: "Make all the changes, but don't do anything to the front page."

## Hard rules
1. NEVER modify page ID **6057** (Home / front page) in any way. Never pass 6057 to any write tool.
2. Do NOT modify ID **12001** (/destin-webdesign-company/, needs manual 301) or **11714** (portfolio item, feeds Home sliders).
3. Do NOT use `search_replace`, `update_site_settings`, `delete_post`, or `upload_media_from_url`. Only `get_post`, `update_post`, `create_post` (only if your batch says so), `list_terms`.
4. Only touch the IDs assigned to your batch.
5. **Before changing any item, back it up**: save the full `get_post` JSON to `/home/user/OCI/seo-audit/rockstar-marketing/backup/<id>.json` (if a get_post result is too big and lands in a tool-results file, copy that file). Never skip the backup.
6. Do NOT change the `title` of pages (menu labels show on the front page). You MAY change titles of blog posts (post_type=post). Do not change page slugs. Post slugs only where your batch says.

## What to change per item
- Source of truth: the audit report HTML at `/home/user/OCI/seo-audit/rockstar-marketing/src/NN-*.html`:
  - §2 meta → set `seo_title`, `seo_description`, `focus_keyword` via update_post.
  - §5 "Rewritten Page Content" → convert to clean, publishable HTML and set as `content`.
  - §4 internal linking plan → every anchor in the copy must get the right `href` (the copy marks targets with `[→ /path/]` notes; use the §4 table for the rest).
- Clean HTML only: `<h1>`, `<h2>`, `<h3>`, `<p>`, `<ul>/<ol>/<li>`, `<a>`, `<strong>`, `<table>`, `<address>`, `<iframe>`, `<img>`. No WPBakery `[vc_*]` shortcodes, no inline colour spans, no `data-*` attributes, no `&nbsp;` spacer paragraphs.
- Remove ALL annotation artifacts from the report: `<span class="tag">…</span>` labels, `[→ …]` notes, "ADD …" lines, notes to the owner.
- **No placeholders in published copy.** Any sentence that contains `[brackets]` needing owner data (founder name, photography, contract terms, case-study numbers, testimonials, certification names, ad budgets, client names) → rewrite it without the unknown fact or drop it. Never invent facts, clients, numbers, testimonials or quotes.
  - Known facts you CAN use: NAP = Rockstar Marketing, 385 Harbor Blvd, Suite 200, Destin, FL 32541; phone (850) 542-3091 → `tel:+18505423091`; toll-free (855) 545-3669 → `tel:+18555453669`; info@rockstar-marketing.com; hours Mon–Fri 9am–5pm, Sat by phone, Sun closed; "since 1996"; Home ranks #1 on Google for "Destin SEO company"; 1 billion+ search keyword on page one; video reached 60M+ people; 102M people reached with a fan page in 30 days (100M+ in a month); 35,000 fans in 24 hours; 4,500+ fans from one text; 50+ posts each reaching 1M+; clients include NFL/NBA players, UFC fighters, Grammy-winning country bands, rock bands, doctors, lawyers, radio stations.
  - Pricing (published in the "Best Destin SEO Company" post): local SEO $1,000–$2,000/mo (foundational), $2,000–$4,000/mo (competitive, most Destin businesses), $4,000–$8,000+/mo (aggressive). For web design / social / video prices you don't know: say "fixed quote after a free consultation" – no numbers.
- Links: use absolute `https://rockstar-marketing.com/<slug>/` with trailing slash. Key URLs: / · /services/ · /seo/ · /social-media/ · /video-marketing/ · /web-design/ · /about-us/ · /contact-us/ · /clients/ · /locations/ · /faq/ · /latest/ · /destin-florida/ · /destin-seo-company/ · /destin-social-media-company/ · /fort-walton-beach-seo-company/ · /fort-walton-beach-social-media-company/ · /fort-walton-beach-web-design/ · /santa-rosa-beach-seo-company/ · /santa-rosa-beach-social-media-company/ · /santa-rosa-beach-web-design-company/ · /pensacola-seo-company/ · /pensacola-social-media-company/ · /pensacola-web-design-company/ · /miramar-beach-social-media-company/ · /ai-marketing/ (new slug of post 12280) · /do-you-need-an-seo-company/ (new slug of post 12305) · /how-to-start-a-youtube-channel-everything-you-need-to-know/ · /instagram-account-step-by-step-guide-to-getting-more-conversions-and-sales/ · /definitive-guide-to-building-and-optimizing-your-amazon-store/ · /best-destin-seo-company-how-to-choose-the-right-partner-for-your-business/. Never link to /destin-webdesign-company/ — use /web-design/ for "Destin web design".
- FAQ anchors: link to `https://rockstar-marketing.com/faq/` (no #fragment unless the FAQ batch created that id).
- CTA buttons: plain links, e.g. `<p><a href="https://rockstar-marketing.com/contact-us/">Get a Free SEO Audit</a> · <a href="tel:+18505423091">Call (850) 542-3091</a></p>`.
- Maps: `<iframe src="(existing embed src)" width="100%" height="350" style="border:0" loading="lazy" title="Map to Rockstar Marketing in Destin, FL" allowfullscreen></iframe>`. Pensacola pages: no map.
- Keep existing Quform shortcodes where the page had them: `[quform id="1" name="Contact us"]` (Contact), `[iphorm id="2" name="Contact Us"]` (Destin social), `[iphorm id="3" name="Video"]` (Video Marketing).
- H1: include one `<h1>` at the top of the content with the report's new H1 text (matches the existing pattern on the city pages). For blog posts do NOT put an H1 in content — set the post `title` to the new H1 instead.
- Images: keep an existing image only if useful, with a descriptive `alt`, `loading="lazy"`, https URL. Remove hot-linked third-party images.
- Blog posts: set `categories` (names): SEO · Social Media · Video & YouTube · eCommerce & AI (create if missing).

## Report back
A short table: ID · what changed (content/meta/title/slug/category) · anything skipped and why · placeholders you dropped.

## Site-wide internal linking (user request, mandatory on EVERY item you edit)
1. Every page/post must contain at least one contextual link to the home page: `<a href="https://rockstar-marketing.com/">Destin SEO company</a>` or `<a href="https://rockstar-marketing.com/">Rockstar Marketing</a>`.
2. Append this exact navigation block as the LAST thing in the content of every page and post you edit (after the CTA). Remove the line that links to the page itself.

```html
<h2>Explore Rockstar Marketing</h2>
<p><strong>Home:</strong> <a href="https://rockstar-marketing.com/">Rockstar Marketing – Destin SEO &amp; Social Media Company</a></p>
<p><strong>Services:</strong> <a href="https://rockstar-marketing.com/services/">All Services</a> · <a href="https://rockstar-marketing.com/seo/">SEO Services</a> · <a href="https://rockstar-marketing.com/social-media/">Social Media Marketing</a> · <a href="https://rockstar-marketing.com/video-marketing/">Video Marketing</a> · <a href="https://rockstar-marketing.com/web-design/">Web Design</a> · <a href="https://rockstar-marketing.com/ai-marketing/">AI Marketing</a></p>
<p><strong>Destin:</strong> <a href="https://rockstar-marketing.com/destin-seo-company/">Destin Local SEO</a> · <a href="https://rockstar-marketing.com/destin-social-media-company/">Destin Social Media</a> · <a href="https://rockstar-marketing.com/destin-florida/">Doing Business in Destin</a> · <a href="https://rockstar-marketing.com/miramar-beach-social-media-company/">Miramar Beach &amp; Sandestin</a></p>
<p><strong>Fort Walton Beach:</strong> <a href="https://rockstar-marketing.com/fort-walton-beach-seo-company/">SEO</a> · <a href="https://rockstar-marketing.com/fort-walton-beach-social-media-company/">Social Media &amp; Video</a> · <a href="https://rockstar-marketing.com/fort-walton-beach-web-design/">Web Design</a></p>
<p><strong>Santa Rosa Beach &amp; 30A:</strong> <a href="https://rockstar-marketing.com/santa-rosa-beach-seo-company/">SEO</a> · <a href="https://rockstar-marketing.com/santa-rosa-beach-social-media-company/">Social Media &amp; Video</a> · <a href="https://rockstar-marketing.com/santa-rosa-beach-web-design-company/">Web Design</a></p>
<p><strong>Pensacola:</strong> <a href="https://rockstar-marketing.com/pensacola-seo-company/">SEO</a> · <a href="https://rockstar-marketing.com/pensacola-social-media-company/">Social Media</a> · <a href="https://rockstar-marketing.com/pensacola-web-design-company/">Web Design</a></p>
<p><strong>Company:</strong> <a href="https://rockstar-marketing.com/about-us/">About Us</a> · <a href="https://rockstar-marketing.com/clients/">Clients</a> · <a href="https://rockstar-marketing.com/locations/">Areas We Serve</a> · <a href="https://rockstar-marketing.com/faq/">FAQ</a> · <a href="https://rockstar-marketing.com/latest/">Blog</a> · <a href="https://rockstar-marketing.com/contact-us/">Contact Us</a> · <a href="https://rockstar-marketing.com/privacy-policy/">Privacy Policy</a></p>
<p><strong>Guides:</strong> <a href="https://rockstar-marketing.com/do-you-need-an-seo-company/">Do You Need an SEO Company?</a> · <a href="https://rockstar-marketing.com/best-destin-seo-company-how-to-choose-the-right-partner-for-your-business/">How to Choose an SEO Company</a> · <a href="https://rockstar-marketing.com/how-to-start-a-youtube-channel-everything-you-need-to-know/">Start a YouTube Channel for Business</a> · <a href="https://rockstar-marketing.com/instagram-account-step-by-step-guide-to-getting-more-conversions-and-sales/">Instagram Marketing for Small Business</a> · <a href="https://rockstar-marketing.com/definitive-guide-to-building-and-optimizing-your-amazon-store/">Amazon Store Optimization</a></p>
```
