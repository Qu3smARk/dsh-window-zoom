# dsh-window-zoom

English | [中文](README.zh.md)

A **whole-window zoom plugin for the DeepSeek Harness web GUI**: it scales the sidebar, the
conversation, the composer and overlays together, keeps a small always-on control in the bottom-right
corner, and supports the keyboard and Ctrl+wheel, with the factor stored per browser profile.

## Install / uninstall

```powershell
# install (link: points at this directory, so edits apply after a page refresh)
dsh plugin --profile desktop add link:<this-directory>

# uninstall
dsh plugin --profile desktop remove dsh-window-zoom
```

After installing, refresh the page (or restart the DSH desktop app) and the control appears in the
bottom-right corner. Replace `--profile` with your own profile name — the CLI's `dsh web`, for
example, uses `web`.

## Usage

| Action | How |
| --- | --- |
| Zoom in | the control's `+`, or `Ctrl+Alt+=` |
| Zoom out | the control's `−`, or `Ctrl+Alt+-` |
| Back to 100% | click the percentage in the middle of the control, or `Ctrl+Alt+0` |
| Fine zoom | `Ctrl+wheel` (5% per step) |
| Move the control | click the arrow grip on its left to cycle the four corners |
| Coordinate-correction toggle | click `⇔` (on by default, see below) |
| Header controls to the left | click `⇤` (on by default, see below) |

- Range 50% – 250%, 10% steps; the shortcuts can be rebound under Settings → Shortcuts.
- The factor and the docked corner live in localStorage
  (`dsh.windowZoom.factor` / `dsh.windowZoom.dock`) and are restored next time.
- The control counter-scales itself, so it keeps its original size at 250% and is never pushed off
  screen.
- Inside the embedded terminal (xterm) `Ctrl+wheel` is not intercepted and stays with the terminal.

## Implementation

Zooming does exactly one thing: it writes the CSS `zoom` property on `<html>`.

```js
document.documentElement.style.zoom = String(factor);
```

One line is enough because this shell lays itself out with an
`html, body, #root { height: 100% }` chain: when the root element carries `zoom`, Chromium scales the
initial containing block along with it, so the percentage chain still fills the window exactly. That
was measured against headless Chromium (see `test/zoom-semantics.html`, viewport 1184×705):

| Root declaration | measured `#root` | fills the window | measured `100vh` |
| --- | --- | --- | --- |
| none | 1184×705 | yes | 705 (= window height) |
| `zoom: 1.5` | 1184×705 | **yes** | 1058 (≈ 1.5 × window height) |
| `zoom: 0.6` | 1184×705 | **yes** | 423 (≈ 0.6 × window height) |
| `zoom: 1.5` + `width/height: 100%/1.5` | 789×470 | no (double compensation) | 1058 |

Conclusion: the root zoom already handles the `100%` chain, so width/height must **not** be
compensated as well — doing so leaves the shell at roughly two thirds of the window. The only lengths
that do not follow are raw `vh`/`vw`, and the shell uses those for overlay `max-height` only.

The control counter-scales through `--dsh-window-zoom-inverse` (`1 / factor`) so its size stays
constant.

## Coordinate correction (the shim)

Writing `zoom` alone **splits the DOM's coordinate system in two**, which was the shared root cause of
three earlier bugs:

| API | measured under a root `zoom: 1.5` (element 200 wide at left 100) | space |
| --- | --- | --- |
| `getBoundingClientRect()` | left 150, width 344 | root-frame (visual) pixels |
| `getClientRects()` / the Range equivalents | width 344 | root frame |
| mouse `clientX/clientY/offsetX/offsetY` | reported in visual pixels (measured `clientX=142`) | root frame |
| `innerWidth` / `documentElement.clientWidth` | 784 / 769 (unchanged by the zoom) | root frame |
| style writes, `offsetWidth`, `computed style`, `scroll*` | around 100, width 229 | zoomed layout pixels |
| `clientWidth` of non-root elements | 210 | layout pixels |

Application code was written against "both agree" — that is, against no zoom — so every place that
*measures a rect and writes a style* lands on `rect × factor`:

- **menus and the account popover**: `left = rect.right - offsetWidth` → off by ×1.5, i.e. off screen;
- **the 【Conversation|Trajectory】 tab strip**: the dock metrics use rect width/height as CSS
  variables → the indicator misses its tab;
- **the composer caret**: Lexical sets the native caret to `caret-color: transparent` and paints its
  own `div` (the block cursor) whose position and height both come from rect math → the caret is drawn
  somewhere else and noticeably too tall.

The `⇔` toggle is that correction: it converts the root-frame API group back into layout space (rects
and rect lists, the mouse coordinates `clientX,clientY,offsetX,offsetY,pageX,pageY,x,y`,
`innerWidth,innerHeight`, the root element's `clientWidth,clientHeight`) and lets the
`elementFromPoint` family accept layout-space coordinates. At 100% every patch passes straight through,
so it is as if the plugin were not installed; unloading restores each one. Hit testing itself happens
inside Blink and is unaffected (measured: clicks still land on the intended character).

To judge whether it matters: `test/shim.test.html` runs the same call patterns twice on one page — all
53 assertions pass with the shim on, and with it off those 6 geometry assertions **all** fail exactly
as the original bug report described.

### Exception: the desktop's native platform view

Pages such as the account Settings → Usage window are not part of the document:
`dsh-client-ui-settings-account` measures the viewport element of a `position:fixed; inset:0` overlay
and hands it to the native bridge:

```js
const bounds = () => { const r = viewport.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } };
bridge.open(page, bounds());            // dshPlatform.open  → WebContentsView
new ResizeObserver(() => bridge.setBounds(bounds()));
```

The main process treats that as **window DIP** when placing a native child view, so this subtree has to
keep root-frame coordinates — the correction layer exempts it explicitly, with the selector
`[role=dialog][aria-modal=true]:has(header[data-window-drag])` (measured: exempt, it reports 180px =
the 180px on screen; strip the platform marker and the very same node is immediately divided by 1.5
into 120px, which shows the exemption is exact and does not leak). That overlay is the only "dialog
containing a `header[data-window-drag]`" in the whole client — every other drag band hangs off a `div`,
and the session header is not inside a dialog.

Conversely, **a native child view always paints above the window's DOM**: while that page is open it
covers the zoom control in the bottom-right corner (and the pet), so they cannot be clicked. Adjust the
zoom before opening it (or close it first); the `Ctrl+Alt+=` / `-` / `0` shortcuts work again once focus
returns to the main UI.

## The Windows title bar and the top-right controls

The desktop shell uses `titleBarStyle: "hidden"` with `titleBarOverlay: { height: 40 }`: the
minimize/maximize/close buttons are a fixed 40 window pixels **painted over the page content**, and the
app reserves that band itself through the preload-injected `--dsh-windows-titlebar-height: 40px`
(layout pixels). After zooming, the band's physical height becomes `40 × factor`, so the session
header's right-hand controls slide into the button band when zooming out and are pushed down when
zooming in.

**Tried and reverted**: compensating that variable by `1/factor` so the band stays 40 physical pixels.
It did not help and made things worse — skins such as `dsh-claude-style` mix
`--dsh-windows-titlebar-height` into their own title-bar geometry (for example
`box-shadow: 0 calc(-1 * var(--dsh-windows-titlebar-height)) 0 0 …`, and they re-lay the tabs after
measuring `titleRow` / `headerUtilities` / `headerCorner`), so changing the variable breaks the skin at
the same time and produced a *complete* overlap. The plugin therefore **no longer touches that
variable** (`test/shim.test.html` asserts it always keeps the value the desktop wrote).

**What it does now**, in two cases. `⇤` is on by default and adds
`data-dsh-window-zoom-header-left` to `<html>`.

**Case one: a skin moves the header into the title bar** (`dsh-claude-style`'s header band). The skin
marks `headerUtilities` / `headerCorner` as `[data-dsh-header-actions]` / `[data-dsh-header-corner]`
and pins them into the title bar with `position:fixed`:

```css
body[data-dsh-claude-style][data-dsh-header-band~=actions] [data-dsh-header-actions],
body[data-dsh-claude-style][data-dsh-header-band~=actions] [data-dsh-header-corner]{
  position:fixed!important;
  top:calc(var(--dsh-windows-titlebar-height, 40px) / 2)!important;
  right:var(--dsh-header-band-right)!important; }
```

The skin does compute that horizontal reservation (`--dsh-header-band-right`, for example `146px` =
3 × 46px buttons + gap), **but it is a window-pixel value written into `right` as if it were layout
pixels**: under zoom the icons grow while the reservation does not, so they end up exactly on top of
minimize/maximize/close.

The plugin therefore re-publishes the same offsets **divided by the factor** from JavaScript, using
inline `!important` (inline important beats a stylesheet important), stacking the clusters leftwards
from the corner and centring them vertically inside the 40px button band:

```js
element.style.setProperty("position", "fixed", "important");
element.style.setProperty("top", (40 / 2) / factor + "px", "important");
element.style.setProperty("right", rightVisual / factor + "px", "important");
element.style.setProperty("transform", "translateY(-50%)", "important");
rightVisual += element.offsetWidth * factor + 8;   // the next cluster continues to the left
```

The result is a **horizontal translation inside the same band**, to the left of the buttons (the same
look as with the plugin disabled) rather than dropping below them. It is re-applied when the zoom
changes, on window resize, when the skin re-measures (`MutationObserver`, 400ms debounce) and at
0.8/2.5/6 seconds after load; turning `⇤` off or unloading the plugin calls `removeProperty` on each one
and hands control back to the skin.

**Case two: no such skin** (the containers are still in the document flow). Then plain CSS puts them at
the far left of the header:

```css
html[data-dsh-window-zoom-header-left]
  header:has(> [class*=titleRow]):has([class*=headerCorner],[class*=headerUtilities]) {
    grid-template-columns: auto auto minmax(0,1fr) !important;   /* corner | leading | title row */
}
/* headerCorner → column 1; headerLeading → column 2; titleRow → column 3,
   and inside titleRow the headerUtilities — like headerActions inside titleCluster —
   is pulled ahead of the title/crumbs with order:-1 */
```

(The skin makes those two containers `position:fixed` in case one, so the grid rules no longer apply to
them and the two paths never interfere.)

- The selector only matches the **session header** (the only `header` that has both a `titleRow` and
  `headerCorner`/`headerUtilities`), so the platform view, the settings panels and other surfaces are
  untouched.
- The structure comes from the real JSX and CSS of `@deepseek-ai/dsh-client-ui-conversation`: `header`
  is `grid(auto minmax(0,1fr))`, `titleRow` is a flex row holding `titleCluster` + `headerUtilities`,
  and `headerCorner` is a grid item next to `titleRow`. `test/header.test.html` builds a mock from that
  structure and asserts that after the move the utilities sit left of the title cluster, the corner is
  leftmost, the same still holds at 150% zoom, and unloading restores everything.
- `!important` is used only to beat the skin's rules for the same containers.

### Header self-diagnostic

The header's real shape depends on which skin is installed (`dsh-claude-style` re-lays and moves these
containers itself), so the plugin ships a self-diagnostic: the client POSTs the **header subtree** (tag,
class, screen coordinates, positioning and visible text of every node) plus every `fixed`/`absolute`
element along the window's top edge to the host half, which writes it to

```
<DSH_HOME>/window-zoom-header-dump.json      # on this machine C:\Users\雷神\.dsh\window-zoom-header-dump.json
```

- The route `POST /api/dsh-window-zoom/header-dump` **only accepts loopback requests** (host must be
  localhost/127.0.0.1/[::1] and `sec-fetch-site` must not be cross-site); everything else gets a 403.
  The body is capped at 512KB.
- It fires 2s and 6s after page load and then, debounced by 1.5s, whenever the header changes — **at
  most 8 times per page load**, always overwriting the same file. It contains structure and coordinates
  only, no images and no credentials.
- The host half is **new** code: the route only appears after **restarting the DSH desktop app** (the
  host process); a page refresh is not enough.

## Known limitations

- A few overlays in the shell use `max-height: calc(100vh …)` / `100dvh` and do not follow the zoom,
  because `vh` takes no part in root-zoom compensation. They size to their content, so this is rarely
  visible in practice.
- This is a "magnify everything" approach rather than browser zoom: the layout viewport keeps its width
  and media queries still see it, so zooming in does not trigger responsive reflow — the UI becomes
  tighter, like a narrower window.
- The coordinate correction patches DOM prototypes globally (the only way to fix the problems above:
  the desktop renderer is sandboxed with `contextIsolation`, so Electron's real zoom is unreachable). It
  only changes values in the direction of "as if there were no zoom", and the native platform view
  subtree is explicitly exempt (see above) — but a third-party library that deliberately relies on
  **visual** coordinates (for example drawing a rect onto a canvas sized in visual pixels) can still be
  affected; click `⇔` off to compare when that happens.
- Opening the desktop's native platform view (usage, top-up, …) covers the window DOM, so the zoom
  control being hidden then is expected: a native child view always paints above the window's web
  content and a plugin cannot get past it.

## Tests

```powershell
chrome --headless=new --disable-gpu --force-device-scale-factor=1 --window-size=900,600 `
       --virtual-time-budget=8000 --dump-dom test/shim.test.html
```

- `test/shim.test.html` (53 assertions): regression test for the coordinate correction. It reproduces
  four call patterns — popover placement, viewport clamping, tab metrics and the Lexical block cursor —
  and asserts the real on-screen position using the **native rect captured before any patching**. It
  also asserts that the platform overlay's rect stays in window DIP, that the exemption does not leak,
  and that the caption-strip variable is never touched by the plugin; with the shim off those geometry
  assertions all fail, and after unload the prototypes and variables are fully restored.
- `test/header.test.html` (23 assertions): regression test for moving the header controls, in two
  scenarios — without a skin the grid/`order` path moves them in the flow; with a skin the title-bar
  offsets are re-published divided by the factor. Assertions include "stays inside the 40px button
  band", "clear of the caption buttons horizontally", "the two clusters do not overlap",
  "offset = 146 / factor", and "inline styles are cleared when disabled or unloaded".
- `test/client.test.html` (47 assertions): the control, the four docks, the limits, persistence, the
  keyboard fallback, Ctrl+wheel, registration with the official shortcut service, and unload.
- `test/space-probe.html`: the measurement page behind the "which API belongs to which space" table,
  including the `100%/1.5` over-compensation control.
- `test/zoom-semantics.html`: the measurement page for the `100%` chain and `100vh` under root zoom.
- `test/caret-click.html` + `test/cdp-click.mjs`: inject real clicks over CDP and verify that clicks
  still land correctly after zooming.
- `test/caret.html`, `test/cdp-caret.mjs`: probes for native caret painting (headless Chromium does not
  paint a caret, so the click landing is the authoritative evidence).
- `test/preview.html` + `test/preview-control.png`: control appearance preview and screenshot.

## Files

| Path | What it is |
| --- | --- |
| `lib/client.js` | browser half: control, shortcuts, wheel, persistence, applying zoom, coordinate correction, header placement |
| `lib/index.js` | host half: the loopback-only diagnostic route |
| `cordis.patch.yml` | profile patch: inserts the `window-zoom` plugin row |
| `test/*.html`, `test/*.mjs` | headless Chromium tests, measurement pages and CDP drivers |
| `test/preview-control.png` | screenshot of the control |

## License

MIT
