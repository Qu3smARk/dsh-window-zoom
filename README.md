# dsh-window-zoom

中文 | [English](README.en.md)

给 DeepSeek Harness Web GUI 用的**整窗缩放插件**：把侧边栏、会话、输入框、弹层一起放大或缩小，
右下角带一个常驻小控件，支持键盘与 Ctrl+滚轮，缩放比例按浏览器本地保存。

## 安装 / 卸载

```powershell
# 安装（link: 指向本目录，改代码后刷新页面即可生效）
dsh plugin --profile desktop add link:<this-directory>

# 卸载
dsh plugin --profile desktop remove dsh-window-zoom
```

装完刷新页面（或重启 DSH 桌面端）即可在右下角看到控件。`--profile` 换成你自己的 profile 名，
例如 CLI 里的 `dsh web` 用的是 `web`。

## 用法

| 操作 | 方式 |
| --- | --- |
| 放大 | 控件 `+`，或 `Ctrl+Alt+=` |
| 缩小 | 控件 `−`，或 `Ctrl+Alt+-` |
| 回到 100% | 点控件中间的百分比，或 `Ctrl+Alt+0` |
| 精细缩放 | `Ctrl+滚轮`（每次 5%） |
| 换位置 | 点控件左侧的箭头手柄，在四个角落间轮换 |
| 坐标校正开关 | 点 `⇔`（默认开启，见下） |
| 顶栏控件左移 | 点 `⇤`（默认开启，见下） |

- 范围 50% – 250%，步进 10%，快捷键可在「设置 → 快捷键」里改绑。
- 比例与控件停靠角存在 localStorage（`dsh.windowZoom.factor` / `dsh.windowZoom.dock`），
  下次打开沿用。
- 控件自身做了反向缩放，因此在 250% 下依然是原尺寸，不会被推出屏幕。
- 内嵌终端（xterm）里 `Ctrl+滚轮` 不拦截，交还给终端自己处理。

## 实现

缩放只做一件事：在 `<html>` 上写 CSS `zoom`。

```js
document.documentElement.style.zoom = String(factor);
```

之所以一行就够，是因为这个外壳用 `html, body, #root { height: 100% }` 链布局：Chromium 在根元素
带 `zoom` 时会同步缩放 initial containing block，百分比链因此仍然正好铺满窗口。这一点用无头
Chromium 实测过（见 `test/zoom-semantics.html`，视口 1184×705）：

| 根元素声明 | `#root` 实测尺寸 | 是否铺满窗口 | `100vh` 实测高度 |
| --- | --- | --- | --- |
| 无 | 1184×705 | 是 | 705（= 窗口高） |
| `zoom: 1.5` | 1184×705 | **是** | 1058（≈ 1.5 倍窗口高） |
| `zoom: 0.6` | 1184×705 | **是** | 423（≈ 0.6 倍窗口高） |
| `zoom: 1.5` + `width/height: 100%/1.5` | 789×470 | 否（重复补偿） | 1058 |

结论：根元素缩放已经处理好了 `100%` 链，**不能**再手动补偿宽高，否则外壳只剩约 2/3；唯一不跟随
的是原始 `vh`/`vw` 长度，而外壳只在弹层的 `max-height` 上用到它们。

控件用 `--dsh-window-zoom-inverse`（即 `1 / factor`）做反向 `scale()`，保证自身尺寸恒定。

## 坐标校正（shim）

只写 `zoom` 会**把 DOM 的坐标系劈成两半**，这是之前三个问题的共同根因：

| API | 根元素 `zoom: 1.5` 下的实测值（元素宽 200，左侧 100） | 所属空间 |
| --- | --- | --- |
| `getBoundingClientRect()` | left 150、width 344 | 根框架（视觉）像素 |
| `getClientRects()` / Range 同名方法 | width 344 | 根框架 |
| 鼠标事件 `clientX/clientY/offsetX/offsetY` | 按视觉像素上报（实测 `clientX=142`） | 根框架 |
| `innerWidth` / `documentElement.clientWidth` | 784 / 769（不随缩放变化） | 根框架 |
| 样式写入、`offsetWidth`、`computed style`、`scroll*` | 100 左右、width 229 | 缩放后的布局像素 |
| 非根元素 `clientWidth` | 210 | 布局像素 |

应用代码是按「两者一致」（也就是没有缩放时）写的，于是所有"量 rect → 写样式"的地方都会落到
`rect × factor` 上：

- **弹层/账号菜单**：`left = rect.right - offsetWidth` → 位置偏 `×1.5`，跑到屏幕外；
- **【对话|轨迹】页签**：dock 度量把 rect 宽高当 CSS 变量用 → 指示条错位；
- **输入框光标**：Lexical 会把原生光标置为 `caret-color: transparent`，自己用一个 div 当光标
  （blockCursor），该 div 的位置与高度都来自 rect 数学 → 光标画在别处、还高了一截。

`⇔` 开关就是这层校正：把根框架那一组 API 折算回布局空间（rect/rect 列表/鼠标坐标
`clientX,clientY,offsetX,offsetY,pageX,pageY,x,y`/`innerWidth,innerHeight`/根元素
`clientWidth,clientHeight`），并让 `elementFromPoint` 一族接受布局空间坐标。100% 时每个补丁直接
透传，等于没装；插件卸载时逐条还原。命中测试本身由 Blink 内部完成，不受影响（实测点击落点正确）。

判断是否开关它：`test/shim.test.html` 会在同一页里跑两遍同样的调用模式，开启时 53 项断言全绿，
关闭时那 6 条位置断言**全部**按 bug 描述失败。

### 例外：桌面端的原生平台视图

账号 → 设置里的「用量」等页面不是文档的一部分：`dsh-client-ui-settings-account` 会把一个
`position:fixed; inset:0` 的 overlay 里的 viewport 元素量出来交给原生桥：

```js
const bounds = () => { const r = viewport.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } };
bridge.open(page, bounds());            // dshPlatform.open  → WebContentsView
new ResizeObserver(() => bridge.setBounds(bounds()));
```

主进程把它当**窗口 DIP** 用来摆放一个原生子视图。所以这棵子树必须保持根框架坐标——校正层对它
显式豁免，选择器 `[role=dialog][aria-modal=true]:has(header[data-window-drag])`（实测：豁免时
上报 180px = 屏幕上的 180px；去掉平台标记后同一节点立刻按 1/1.5 折算成 120px，证明豁免是精确的、
不外溢的）。整个客户端里只有这个 overlay 是"dialog 里带 `header[data-window-drag]`"——
其它拖拽条都挂在 `div` 上，会话顶栏也不在 dialog 内。

反过来说，**原生子视图永远盖在窗口 DOM 之上**：这个页面打开时，右下角的缩放控件（以及宠物）
会被它挡住，点不到。要调缩放请先关掉该页面（或先调好再打开）；快捷键 `Ctrl+Alt+=` / `-` / `0`
在焦点回到主界面后同样有效。

## Windows 标题栏与右上角控件

桌面端用 `titleBarStyle: "hidden"` + `titleBarOverlay: { height: 40 }`：最小化/最大化/关闭按钮是
**覆盖在网页内容之上**的固定 40 窗口像素，应用靠预加载脚本注入的
`--dsh-windows-titlebar-height: 40px`（布局像素）自己让出这条带子。缩放后这条带子的物理高度
变成 `40 × 系数`，会话顶栏右侧的控件就会在缩小时滑进按钮带、在放大时被整体压低。

**试过、已回退的做法**：把该变量按 `1/factor` 补偿，让带子的物理高度恒为 40px。实测无效且更糟——
`dsh-claude-style` 这类皮肤会把 `--dsh-windows-titlebar-height` 混进自己的顶栏几何
（例如 `box-shadow: 0 calc(-1 * var(--dsh-windows-titlebar-height)) 0 0 …`，以及按 `titleRow` /
`headerUtilities` / `headerCorner` 量 rect 后重排标签页），改动这个变量等于同时改坏皮肤，
于是出现"彻底重叠"。所以插件**不再触碰该变量**（`test/shim.test.html` 会断言它始终保持
桌面端写入的原值）。

**现在的做法（两种情况分别处理）**：`⇤` 开关默认开启，按下后给 `<html>` 加
`data-dsh-window-zoom-header-left`。

**情况一：装了把顶栏搬进标题栏的皮肤**（`dsh-claude-style` 的 header band）。皮肤把
`headerUtilities` / `headerCorner` 标记成 `[data-dsh-header-actions]` / `[data-dsh-header-corner]`，
用 `position:fixed` 钉进标题栏：

```css
body[data-dsh-claude-style][data-dsh-header-band~=actions] [data-dsh-header-actions],
body[data-dsh-claude-style][data-dsh-header-band~=actions] [data-dsh-header-corner]{
  position:fixed!important;
  top:calc(var(--dsh-windows-titlebar-height, 40px) / 2)!important;
  right:var(--dsh-header-band-right)!important; }
```

皮肤自己算过这个横向留白（`--dsh-header-band-right`，例如 `146px` = 3×46px 按钮 + 间隔），
**但那是个"窗口像素"的值，却被当成布局像素写进 `right`**：缩放后图标跟着变大、留白却不变，
于是正好压到最小化/最大化/关闭上。

插件因此在 JS 里重发同一组偏移并**除以缩放系数**，用内联 `!important` 写回（内联 important 胜过
皮肤样式表里的 important），从角标区开始依次向左堆叠，并垂直居中在 40px 按钮带内：

```js
element.style.setProperty("position", "fixed", "important");
element.style.setProperty("top", (40 / 2) / factor + "px", "important");
element.style.setProperty("right", rightVisual / factor + "px", "important");
element.style.setProperty("transform", "translateY(-50%)", "important");
rightVisual += element.offsetWidth * factor + 8;   // 下一个容器继续往左排
```

结果是**同一水平带内横向平移**到按钮左侧（与没开插件时同样的观感），而不是掉到下面去。
触发时机：缩放变化、窗口 resize、皮肤重新量算（`MutationObserver` 去抖 400ms）以及加载后
0.8/2.5/6 秒各一次；关闭 `⇤` 或卸载插件时，逐条 `removeProperty` 把控制权还给皮肤。

**情况二：没有这类皮肤**（容器仍在文档流里）。此时用纯 CSS 把它们排到顶栏最左：

```css
html[data-dsh-window-zoom-header-left]
  header:has(> [class*=titleRow]):has([class*=headerCorner],[class*=headerUtilities]) {
    grid-template-columns: auto auto minmax(0,1fr) !important;   /* 角标 | leading | 标题行 */
}
/* headerCorner → 第 1 列；headerLeading → 第 2 列；titleRow → 第 3 列，
   titleRow 里的 headerUtilities 与 titleCluster 里的 headerActions 都用 order:-1
   提到标题/面包屑前面 */
```

（皮肤在情况一下把这两个容器变成 `position:fixed`，网格规则对它们自然失效，两条路径互不干扰。）

- 选择器只命中**会话顶栏**（唯一同时拥有 `titleRow` 与 `headerCorner`/`headerUtilities` 的
  `header`），平台视图、设置面板等其它 surfaces 不受影响。
- 结构取自 `@deepseek-ai/dsh-client-ui-conversation` 的真实 JSX 与 CSS：`header` 是
  `grid(auto minmax(0,1fr))`，`titleRow` 是 flex 且含 `titleCluster` + `headerUtilities`，
  `headerCorner` 是与 `titleRow` 同级的 grid 项。`test/header.test.html` 用这份结构搭了 mock，
  断言左移后 utilities 落在标题簇左侧、角标最靠左、并且 150% 缩放下依然成立、卸载后完全还原。
- `!important` 只用于压过皮肤对同一批容器的规则。

### 顶栏自诊断

顶栏的真实结构取决于装了什么皮肤（`dsh-claude-style` 会自己重排、搬动这些容器），所以插件带一个
自诊断：客户端把**顶栏子树**（每个节点的 tag、class、屏幕坐标、定位方式、可见文字）以及所有贴在
窗口顶部的 `fixed`/`absolute` 元素，POST 给宿主半区；宿主写到

```
<DSH_HOME>/window-zoom-header-dump.json      # 本机为 C:\Users\雷神\.dsh\window-zoom-header-dump.json
```

- 路由 `POST /api/dsh-window-zoom/header-dump` **只接受回环请求**（host 必须是 localhost/127.0.0.1/[::1]
  且 `sec-fetch-site` 非 cross-site），其余一律 403；请求体上限 512KB。
- 触发时机：页面加载后 2 秒、6 秒各一次，之后顶栏有变化时去抖 1.5 秒再写；**每次页面加载最多 8 次**，
  始终覆盖同一个文件。内容只有结构与坐标，不含图片或凭据。
- 宿主半区是**新增**代码，改完需要**重启 DSH 桌面端**（宿主进程）才会挂上这条路由；只刷新页面不会。

## 已知限制

- 外壳里少量 `max-height: calc(100vh …)` / `100dvh` 的弹层（长菜单、确认框、图片灯箱）不会跟随
  缩放：`vh` 不参与根元素缩放补偿。这些元素按内容收缩，日常几乎看不出差别。
- 本方案是「整体放大」而不是浏览器缩放：布局视口宽度不变，媒体查询仍按原始宽度判定，
  因此放大后不会触发响应式换行，而是像窗口变窄一样更紧凑。
- 坐标校正是对 DOM 原型的全局补丁（这是修复上述问题的唯一途径，桌面端的渲染进程是沙箱 + 
  `contextIsolation`，拿不到 Electron 的真缩放）。它只在与"无缩放"一致的方向上改数值，原生平台
  视图那一棵子树已显式豁免（见上），但第三方库若主动依赖**视觉**坐标（例如把 rect 画到按视觉像素
  设尺寸的 canvas 上）仍可能受影响；遇到时点 `⇔` 关闭即可对比。
- 打开桌面端原生平台视图（用量、充值等）时，该视图覆盖窗口 DOM，缩放控件被挡住属预期行为：
  原生子视图始终绘制在窗口 web 内容之上，插件无法越过它。

## 测试

```powershell
chrome --headless=new --disable-gpu --force-device-scale-factor=1 --window-size=900,600 `
       --virtual-time-budget=8000 --dump-dom test/shim.test.html
```

- `test/shim.test.html`（53 项）：坐标校正的回归测试。复现弹层定位、视口夹取、页签度量与
  Lexical blockCursor 四种调用模式，用**修补前捕获的原生 rect** 断言屏幕上的真实位置；另外断言
  平台 overlay 的 rect 保持窗口 DIP、豁免不外溢、标题栏条带变量始终未被插件改动，并验证关闭 shim
  时那些位置断言必然失败、卸载后原型与变量完全还原。
- `test/header.test.html`（23 项）：顶栏控件左移的回归测试，两种场景——无皮肤时靠网格/`order`
  在文档流里左移；有皮肤时按缩放系数重发标题栏偏移。断言含"留在 40px 按钮带内""横向避开按钮区"
  "两容器不重叠""偏移 = 146/系数""关闭与卸载后内联样式清空"。
- `test/client.test.html`（47 项）：控件、四角停靠、上下限、持久化、键盘回退、Ctrl+滚轮、
  官方快捷键服务注册、卸载还原。
- `test/space-probe.html`：上面那张"哪个 API 属于哪个空间"的实测页（带 `100%/1.5` 过度补偿对照）。
- `test/zoom-semantics.html`：`100%` 链与 `100vh` 在根元素缩放下的实测页。
- `test/caret-click.html` + `test/cdp-click.mjs`：用 CDP 注入真实点击，验证缩放后点击落点仍然正确。
- `test/caret.html`、`test/cdp-caret.mjs`：原生光标绘制的探针（无头环境下 Chromium 不绘制光标，
  因此结论以点击落点为准）。
- `test/preview.html` + `test/preview-control.png`：控件外观预览与截图。

## 文件

| 路径 | 作用 |
| --- | --- |
| `lib/client.js` | 浏览器半区：控件、快捷键、滚轮、持久化、缩放施加、坐标校正 |
| `lib/index.js` | 宿主半区：仅诊断路由（回环限定） |
| `cordis.patch.yml` | profile 补丁：插入 `window-zoom` 插件行 |
| `test/*.html`、`test/*.mjs` | 无头 Chromium 测试、实测页与 CDP 驱动 |
| `test/preview-control.png` | 控件外观截图 |

## License

MIT
