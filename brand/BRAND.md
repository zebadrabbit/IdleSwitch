# IdleSwitch brand kit v1.0

IdleSwitch is a CTC rail terminal that runs itself. The brand is lifted straight off the dispatcher's panel: the same colours the app paints with, the same 45° turnouts, the same rule that a set route is lit and an unset leg draws dim.

Live: https://firetailfab.com/idleswitch/ · Source: https://github.com/zebadrabbit/idleswitch

## The mark

A turnout. Grey track comes in from the left; at the points the route is set up the diverging leg (green, lit) while the straight-through leg carries on dim. That is the whole app in one glyph: the operator has already set the route and the trains keep running.

- In lockups the main track sits on the wordmark's baseline and the set leg rises to cap height.
- The angle is 45°, the same as the panel's crossovers. Don't change it.
- The dim leg is part of the mark. Keep it, even in one-colour versions (it drops to 30–35 % opacity there).

## Wordmark

"Idle" in IBM Plex Sans Medium, Text colour. "Switch" in IBM Plex Sans SemiBold, Accent blue — the colour of a route a human set. One word, no space, capital I and S. All wordmarks are outlined paths; no fonts needed to use them.

## Lockups (logo/svg, logo/png)

| File | Use |
|---|---|
| `idleswitch-horizontal-*` | Default. Headers, banners, README, anywhere wide. |
| `idleswitch-stacked-*` | Square-ish spaces, thumbnails, splash. |
| `idleswitch-wordmark-*` | Text-only, when the mark is already nearby. |
| `idleswitch-glyph-*` | The turnout alone, no tile. Inline icons, 16–64 px. |
| `idleswitch-mark-*` | Glyph on the rounded panel tile. Avatars, favicons; safe for circular crops. |
| `idleswitch-icon-color` | Full-bleed square tile. iOS / PWA icons (the OS rounds it). |
| `idleswitch-hud-*` / `hudglyph` | Compact lockup tuned for the app's 32 px HUD. |

Colour variants: `color` (dark backgrounds, the default), `color-light` (light backgrounds), `mono-light` (white, on dark or photos), `mono-dark` (near-black, on light), `accent` (all Accent blue, on dark).

Minimum sizes: horizontal 110 px wide, stacked 72 px tall, glyph/mark 16 px. Clear space around any lockup: the cap height of the wordmark (the height of the "I") on all sides.

## Colour

Everything comes from `src/style.css` and `render.js` in the app. Use these exact values.

| Role | Hex | On the panel |
|---|---|---|
| Void (background) | `#0b1020` | the panel itself |
| Panel | `#121a2e` | HUD, docks, logo tile |
| Panel border | `#243052` | hairlines, tile edge |
| Text | `#cfd6ea` | labels, "Idle" |
| Dim | `#7d88a6` | secondary text |
| Accent (primary) | `#5aa9ff` | human-set route; "Switch"; links, buttons |
| Route green | `#39d353` | operator-set route; the mark's lit leg |
| Amber | `#f0b429` | slow orders, MANUAL, warnings |
| Red | `#ff4d4f` | occupied track |
| Track | `#8a93ab` | idle track; the mark's approach |
| Track dim | `#3a4463` | unset leg |
| Lamp R / Y / G | `#ff3b30` `#ffcc00` `#34c759` | signal lamps — only ever as lamps |

Ratios on dark surfaces: Void and Panel dominate; Text for copy; Accent for the one thing you can act on; Green for status that is fine; Amber/Red for status that isn't. Never use Red or Amber decoratively.

Train-type colours (X yellow `#f5d90a`, P amber `#ffd166`, Z purple `#c77dff`, M blue `#5aa9ff`, C grey `#9aa0a6`, G orange `#e0a458`, I cyan `#4cc9f0`, L green `#8ac926`) are data colours, not brand colours. Leave them to the board.

## Type

- Display and headings: **IBM Plex Sans** SemiBold (600). Tight tracking (−1 %), sentence case.
- Body: **IBM Plex Sans** Regular. 
- Data, seeds, IDs, times: **IBM Plex Mono** Regular/Medium — the brand's "HUD" voice, used wherever the app would use its monospace.
- All SIL Open Font License; the TTFs are in `fonts/` with the licence.

The app itself deliberately ships no web fonts (system-ui + the system monospace). That's fine: Plex is for things *about* IdleSwitch; the logo files are outlined so the app never has to load it.

## Voice

Plain, declarative, a little wry. Short sentences. The README is the reference. Taglines:

- **The trains keep running.** (primary)
- A rail terminal that runs itself.
- Sit back and watch a CTC terminal run itself.
- Take the panel when you like.

Keep it observational and warm. Avoid lines that tell the viewer they're not needed — the point is that it's a pleasure to watch, not that they're surplus.

Say "terminal", "panel", "operator", "route", "signal", "switch". Don't say "game" unless comparing; it's an idle sim and a screensaver.

## Imagery

Real renders of the app, at night (`?ff=1500–1700` with the default 4-minute day puts the sim in deep night): headlights, EOT markers, signal halos, lit platforms. Zoomed in two or three wheel steps so the terminal fills the frame. Bare panel (H) so no chrome. Overlay the lockup on a Void gradient so copy stays readable. Every plate in this kit is a real seed (`lantern`, `qgxriz`) — anyone can reproduce it.

## Platform index

| Folder | Files | Sizes |
|---|---|---|
| `app/` | HUD logo, glyph, favicons, touch icon, PWA icons, `hud-logo.patch` | 20 px SVGs; 16/32/180/192/512 px PNG |
| `github/` | avatar, social preview, README banner | 512², 1280×640, 1600×400 |
| `reddit/` | community icon, banner, mobile banner | 256², 1920×384, 1080×256 |
| `social/` | avatar, X/Mastodon header, Bluesky banner, OG image, YouTube channel art + avatar + thumbnail, itch cover, square post | 400², 1500×500, 3000×1000, 1200×630, 2560×1440, 800², 1280×720, 630×500, 1080² |
| `wallpaper/` | two seeds × 1080p/1440p/4K, ultrawide, phone; `-clean` = no lockup | 1920×1080, 2560×1440, 3840×2160, 3440×1440, 1170×2532 |

YouTube channel art keeps the lockup inside the 1546×423 safe area. X and Reddit headers keep the lockup right so the avatar (bottom-left) doesn't cover it.

## Putting the logo in the app

`app/hud-logo.patch` applies against the repo root (`git apply app/hud-logo.patch`), then copy `app/assets/` to the repo root. It:

1. Replaces the plaintext wordmark in `#hud` with `logo-hud.svg` (18 px tall; `logo-glyph.svg` takes over under 1160 px instead of the name vanishing).
2. Adds `favicon.svg` / `favicon-32.png` / `apple-touch-icon.png` links to `<head>`.
3. Leaves `H` (bare panel) and everything else alone. No new dependencies.

## Credits

Brand kit prepared by Erin "Panda" Lukens (winter@firetailfab.com) with Claude (Anthropic) — mark, lockups, palette rationale, platform renders and guidelines were designed and generated in a Claude session; the plates are IdleSwitch's own renders. Fonts: IBM Plex, © IBM, SIL OFL 1.1.
