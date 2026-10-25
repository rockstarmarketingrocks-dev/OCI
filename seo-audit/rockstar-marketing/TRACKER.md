# Rockstar Marketing – Page-by-Page SEO Audit Tracker

Site: https://rockstar-marketing.com/ · Each audit = one PDF (findings + rewritten content + changelog) in this folder.
Process: audit the next `[ ]` page, save `NN-slug.pdf`, mark it `[x]`.

| # | Status | Page | WP ID | URL | Report |
|---|--------|------|-------|-----|--------|
| 1 | [x] done 2026-10-25 | Home | 6057 | / | 01-home.pdf |
| 2 | [x] done 2026-10-25 | Services | 11534 | /services/ | 02-services.pdf |
| 3 | [x] done 2026-10-25 | Search Engine Optimization | 11538 | /seo/ | 03-seo.pdf |
| 4 | [x] done 2026-10-25 | Social Media | 11541 | /social-media/ | 04-social-media.pdf |
| 5 | [x] done 2026-10-25 | Video Marketing | 11544 | /video-marketing/ | 05-video-marketing.pdf |
| 6 | [x] done 2026-10-25 | Web Design | 11546 | /web-design/ | 06-web-design.pdf |
| 7 | [x] done 2026-10-25 | About Us | 11548 | /about-us/ | 07-about-us.pdf |
| 8 | [x] done 2026-10-25 | Contact us | 11576 | /contact-us/ | 08-contact-us.pdf |
| 9 | [x] done 2026-10-25 | Clients | 4015 | /clients/ | 09-clients.pdf |
| 10 | [x] done 2026-10-25 | Locations | 12023 | /locations/ | 10-locations.pdf |
| 11 | [x] done 2026-10-25 | FAQ | 12060 | /faq/ | 11-faq.pdf |
| 12 | [x] done 2026-10-25 | Destin SEO Company | 11989 | /destin-seo-company/ | 12-destin-seo-company.pdf |
| 13 | [x] done 2026-10-25 | Destin Social Media Company | 11942 | /destin-social-media-company/ | 13-destin-social-media-company.pdf |
| 14 | [x] done 2026-10-25 | Destin Web Design Company | 12001 | /destin-webdesign-company/ | 14-destin-webdesign-company.pdf (301 → /web-design/) |
| 15 | [x] done 2026-10-25 | Fort Walton Beach SEO Company | 12093 | /fort-walton-beach-seo-company/ | 15-fort-walton-beach-seo-company.pdf |
| 16 | [x] done 2026-10-25 | Fort Walton Beach Social Media Company | 12112 | /fort-walton-beach-social-media-company/ | 16-fort-walton-beach-social-media-company.pdf |
| 17 | [x] done 2026-10-25 | Fort Walton Beach Web Design Company | 12120 | /fort-walton-beach-web-design/ | 17-fort-walton-beach-web-design.pdf |
| 18 | [x] done 2026-10-25 | Santa Rosa Beach SEO Company | 12041 | /santa-rosa-beach-seo-company/ | 18-santa-rosa-beach-seo-company.pdf |
| 19 | [x] done 2026-10-25 | Santa Rosa Beach Social Media Company | 12026 | /santa-rosa-beach-social-media-company/ | 19-santa-rosa-beach-social-media-company.pdf |
| 20 | [x] done 2026-10-25 | Santa Rosa Beach Web Design Company | 12056 | /santa-rosa-beach-web-design-company/ | 20-santa-rosa-beach-web-design-company.pdf (EMPTY PAGE – noindex now) |
| 21 | [x] done 2026-10-25 | Pensacola SEO Company | 12139 | /pensacola-seo-company/ | 21-pensacola-seo-company.pdf |
| 22 | [x] done 2026-10-25 | Pensacola Social Media Company | 12170 | /pensacola-social-media-company/ | 22-pensacola-social-media-company.pdf |
| 23 | [x] done 2026-10-25 | Pensacola Web Design Company | 12157 | /pensacola-web-design-company/ | 23-pensacola-web-design-company.pdf |
| 24 | [ ] | Miramar Beach Social Media Company | 11955 | /miramar-beach-social-media-company/ | |
| 25 | [ ] | Destin Florida | 12182 | /destin-florida/ | |
| 26 | [ ] | Latest | 12215 | /latest/ | |
| 27 | [ ] | Privacy Policy | 11909 | /privacy-policy/ | |
| 28+ | [ ] | 6 blog posts + 1 portfolio item (IDs listed when reached) | | | |

## Site-wide notes carried between pages
- Live site not reachable from the audit sandbox; audits use WP connector data + Semrush (US). Items tagged "Verify live" need a browser check.
- Home ranks #1 "destin seo company" – avoid cannibalizing with /destin-seo-company/.
- Duplicate meta description shared by Home, Clients, About Us, Contact Us.
- Site-wide http:// → https:// search-replace needed.
- 12 pages have no custom SEO title; 21 have no focus keyphrase.
- Services hub: future pages backlog = PPC Management, Online Reputation Management, GBP Optimization, Niceville location page.
- Burst theme likely prints page title as H1 – check every classic-editor page for missing/duplicate H1.
- NAP (from /seo/): Rockstar Marketing, 385 Harbor Blvd Suite 200, Destin, FL 32541, (850) 542-3091 → use for [PHONE] placeholders + schema.
- Keyword ownership: Home = "Destin SEO company"; /seo/ = "SEO services Destin / Destin search engine optimization"; /services/ = "digital marketing services Destin".
- WPBakery pages contain base64 &nbsp; vc_raw_html spacer blocks – check each.
- Keyword ownership: /social-media/ = "social media marketing services" (national); city social pages = local intent (local volumes 0–70/mo).
- Keyword ownership: /video-marketing/ = "video marketing services" + "Destin video marketing" (Home currently #1 – shift via anchor link). Backlog: YouTube SEO Services page.
- Keyword ownership: /web-design/ = "Destin web design" (#2–4 on 9 variants). /destin-webdesign-company/ = 301 candidate (decide in audit #14). Experience claim: use "since 1996".
- Extra NAP (from /contact-us/): toll-free (855) 545-3669, info@rockstar-marketing.com, hours Mon–Fri 9–5, Sat by phone, Sun closed. Lead tracking depends on new /thank-you/ page (CU-01).
- Site-wide: image attachment pages are public (e.g. /jh-3/, /clients/sssss/) – redirect/noindex in AIOSEO (CL-06). Media titles are junk ("aaaa", "2323") – alt text likely empty everywhere.
- FAQ is the single FAQPage-schema source; service-page FAQs stay short and link to /faq/ (no duplicate FAQ schema).
- /destin-seo-company/ = re-focused to "Local SEO Destin / GBP" (no rankings; Home owns head term). City SEO pages (FWB/SRB/Pensacola) likely share its Jan-2023 template – check for stuffing + /locations anchor.
- Forms: Quform 1 = Contact, 2 = Destin Social (+ maybe others), 3 = Video → all redirect to /thank-you/?form=N&service=&city=.
- QUICK WIN: "fort walton beach seo company" 260/mo KD 7 – Home ranks #15, FWB page not in top 100. /destin-florida/ ranks #42 for FWB SEO term.
- SRB cluster ≈640/mo (seo company 170, SEO 90/50, digital marketing ×6) scattered over 6 URLs → consolidate on /santa-rosa-beach-seo-company/. SRB video marketing (50) ranks #8 via SRB social page.
- TOP OPPORTUNITY: Pensacola SEO cluster ≈1,130/mo, KD 2–9, CPC ~$24; site not in top 100. Organic only (no Pensacola address → no map pack; do NOT create virtual GBP address).
- 2nd OPPORTUNITY: Pensacola web design cluster ≈910/mo, KD 5–34, CPC ~$15; not in top 100.
