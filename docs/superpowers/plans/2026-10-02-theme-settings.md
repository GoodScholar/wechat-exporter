# Theme Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three switchable, independently persisted and strictly bounded typesetting themes without changing Markdown semantics or weakening the existing atomic document workflow.

**Architecture:** Extend the existing typesetting document with a normalized theme name and a complete three-theme settings map, so settings share the document revision and manifest transaction. Keep Markdown rendering theme-independent; the render API returns separately validated presentation data that the browser applies as one scoped theme class and four CSS variables.

**Tech Stack:** Node.js 22+, Express 5, Marked, sanitize-html, browser-native JavaScript/CSS, Playwright, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-02-theme-settings-design.md`

## Global Constraints

- Implement GitHub Issue #5 only; do not begin #6–#10.
- Fixed upstream reference: doocs/md commit `a7c17fc4cda92e3c13aa7e24f06615cfa4219b31`, WTFPL v2.
- Theme names are exactly `default`, `grace`, and `simple`; UI labels are 默认、雅致、简洁.
- Settings are fixed enumerations from the spec; arbitrary CSS, arbitrary colors, and arbitrary numeric values are forbidden.
- Theme changes must never alter the HTML generated from a given Markdown body.
- Preserve the existing revision, atomic current/recovery manifest, import, rich-paste, autosave, CSP, and offline-test behavior.
- Tests must use local processes and fixtures only; no external network requests.

## Review Focus

- A legacy persisted document with neither new field must load with all defaults, while a partially supplied new theme configuration must fail instead of silently resetting values; pinned in Task 1.
- A theme or setting change at an already committed revision must return 409 and leave current/recovery files unchanged; pinned in Task 1.
- A slow preview for an older theme must not overwrite a newer theme class or CSS variables; pinned in Task 4.
- Article import and rich-text paste must preserve all three theme settings, including non-current themes; pinned in Tasks 3 and 4.
- CSS-like payloads, unknown keys, mixed-case colors, and out-of-enum numbers must return 400 and never reach DOM styles or persistence; pinned in Tasks 1, 2, and 4.

---

### Task 1: Extend the atomic document schema

**Files:**
- Modify: `src/typesetting.js:7-110`
- Modify: `test/typesetting.test.js:30-79`

**Interfaces:**
- Produces: `typesettingThemeNames` as the frozen ordered list `['default', 'grace', 'simple']`.
- Produces: `createDefaultThemeSettings() -> { default, grace, simple }`, returning fresh nested objects with the exact spec defaults.
- Produces: `normalizeTypesettingPresentation({ theme, settings }) -> { theme, settings }`, performing strict theme and setting-key/value validation for render requests.
- Extends every normalized document with `theme` and `themeSettings`; callers of `TypesettingStore.load()` and `.save()` receive the complete normalized document.

- [ ] **Step 1: Add failing model and migration tests**

Add tests named:

- `旧排版文稿补齐三套默认主题并在下次保存后跨重启持久化`
- `排版文稿拒绝不完整、额外或越界的主题设置且不改变已保存版本`
- `主题及非当前主题设置参与修订冲突和内容相等判断`
- `主题设置写入失败时旧配置仍是内存和重启后的唯一可见状态`

Assert exact defaults, fresh independent nested objects, legacy compatibility only when both new top-level fields are absent, 400 for strict-schema violations, 409 for same/older revision content changes, and unchanged manifest/current/recovery after injected write failure.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --test --test-name-pattern='旧排版文稿补齐|排版文稿拒绝|主题及非当前|主题设置写入失败' test/typesetting.test.js`

Expected: FAIL because the normalized document has no theme model or strict validator.

- [ ] **Step 3: Implement the minimal schema and validator**

In `src/typesetting.js`:

- define the exact theme names, option sets, setting keys, and default values once;
- make `emptyDocument()` include a fresh complete settings map;
- let `normalizeDocument()` migrate only the fully legacy shape, but strictly validate a supplied new shape and reject missing/extra nested keys;
- include theme and all three settings objects in same-content comparison;
- keep revision, savedAt, version-file, manifest, recovery, and cleanup order unchanged;
- export only the three interfaces listed above for later tasks and tests.

- [ ] **Step 4: Run focused and existing store tests**

Run: `node --test --test-name-pattern='排版文稿|主题|recovery|manifest|候选' test/typesetting.test.js test/typesetting-import.test.js`

Expected: PASS, including the new tests and existing atomic persistence tests.

- [ ] **Step 5: Commit the schema milestone**

```bash
git add src/typesetting.js test/typesetting.test.js
git commit -m "feat: persist per-theme settings"
```

### Task 2: Return theme-neutral HTML plus validated presentation

**Files:**
- Modify: `src/typesetting.js:102-110`
- Modify: `src/server.js:52-79`
- Modify: `public/typesetting-theme.css:1`
- Modify: `THIRD_PARTY_NOTICES.md:3-23`
- Modify: `test/typesetting.test.js`

**Interfaces:**
- Consumes: `normalizeTypesettingPresentation({ theme, settings })` from Task 1.
- Changes: `renderTypesettingMarkdown(body, presentation) -> { html, presentation }`.
- Produces: scoped classes `typeset-theme-default`, `typeset-theme-grace`, and `typeset-theme-simple` and variables `--md-primary-color`, `--md-font-size`, `--md-line-height`, `--md-block-spacing`.

- [ ] **Step 1: Add failing render, validation, CSS, and notice tests**

Add tests named:

- `三套主题对代表性 Markdown 生成完全相同的语义 HTML`
- `预览 API 只返回白名单 presentation 并原子拒绝非法主题值`
- `三套主题样式全部作用域化且不加载外部资源`
- `第三方说明记录三套主题、设置来源、固定提交和许可证`

Use representative Markdown containing headings, paragraphs, emphasis, lists, blockquotes, fenced code, an HTTPS image, a link, horizontal rule, and a table. Assert byte-identical `html` for all themes, exact normalized presentation, 400 for unknown/partial/extra/CSS-like values, and no remote `@import`, font, script, or stylesheet URL in theme CSS.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test --test-name-pattern='三套主题对代表性|预览 API 只返回|三套主题样式|第三方说明' test/typesetting.test.js`

Expected: FAIL because render accepts only `body`, returns no presentation, and only the default theme exists.

- [ ] **Step 3: Implement the render boundary and scoped themes**

- Change `/api/typesetting/render` to require `body`, `theme`, and current `settings`, then pass them through the shared validator.
- Keep the existing Marked and sanitize-html result independent of presentation.
- Extend `public/typesetting-theme.css` with a common scoped base and minimal supported-selector adaptations from upstream default/grace/simple CSS.
- Use `var(--md-block-spacing)` to scale each theme's own vertical rhythm; do not add unsupported doocs features.
- Update `THIRD_PARTY_NOTICES.md` with the two new theme files, `style.ts`, `theme.ts`, the fixed commit, license, and local adaptation boundaries.

- [ ] **Step 4: Run focused render tests and syntax checks**

Run: `node --test --test-name-pattern='Markdown|预览 API|主题样式|第三方说明' test/typesetting.test.js`

Run: `node --check src/typesetting.js && node --check src/server.js`

Expected: all selected tests PASS; both syntax checks exit 0.

- [ ] **Step 5: Commit the rendering milestone**

```bash
git add src/typesetting.js src/server.js public/typesetting-theme.css THIRD_PARTY_NOTICES.md test/typesetting.test.js
git commit -m "feat: render three bounded themes"
```

### Task 3: Preserve presentation across article import

**Files:**
- Modify: `src/typesetting-import.js:51-75`
- Modify: `test/typesetting-import.test.js`

**Interfaces:**
- Consumes: the complete document returned by `TypesettingStore.load()`.
- Guarantees: `importTypesettingDocument()` replaces only title, author, account, publishedAt, and body; it copies `current.theme` and the complete `current.themeSettings` into the next revision.

- [ ] **Step 1: Add a failing import regression test**

Add `文章导入替换内容但保留当前主题和全部非当前主题设置`.

Save a document whose three themes contain distinct allowed values, import a local normal-article fixture, restart the service, and assert the imported metadata/body changed while theme plus all three setting objects remain byte-for-byte equal. Also assert failed, unconfirmed, and revision-conflict imports leave theme settings unchanged.

- [ ] **Step 2: Run the import test and verify RED**

Run: `node --test --test-name-pattern='文章导入替换内容但保留' test/typesetting-import.test.js`

Expected: FAIL because the import candidate currently contains only article fields and revision.

- [ ] **Step 3: Preserve presentation in the import candidate**

In `importTypesettingDocument()`, copy the normalized current `theme` and complete `themeSettings` into the candidate immediately before saving. Do not change fetch, confirmation, error mapping, message-type, or revision behavior.

- [ ] **Step 4: Run all import tests**

Run: `node --test test/typesetting-import.test.js`

Expected: all import tests PASS.

- [ ] **Step 5: Commit the import integration**

```bash
git add src/typesetting-import.js test/typesetting-import.test.js
git commit -m "fix: preserve themes during article import"
```

### Task 4: Add the workbench controls and integration behavior

**Files:**
- Modify: `public/typesetting.html:5-6`
- Modify: `public/typesetting.js:1-162`
- Modify: `public/style.css` in the typesetting-page section
- Modify: `test/typesetting.test.js`

**Interfaces:**
- Consumes: the complete document from Task 1 and `{ html, presentation }` from Task 2.
- Produces DOM controls: `#document-theme`, `#theme-primary-color`, `#theme-font-size`, `#theme-line-height`, `#theme-block-spacing`, and `#reset-theme`.
- Applies only server-returned presentation to `#preview`; the preview root has exactly one `typeset-theme-*` class and the four validated CSS variables.

- [ ] **Step 1: Add failing browser integration tests**

Add tests named:

- `工作台切换三套主题时正文结构不变且即时应用服务端 presentation`
- `每套主题独立记忆四项设置并只重置当前主题`
- `主题设置自动保存并在刷新和服务重启后恢复`
- `慢的旧主题预览不会覆盖较新的主题类和变量`
- `文章导入和富文本粘贴不会重置或污染主题设置`
- `主题设置在窄屏可操作且页面不产生横向溢出`

Assert select values, computed theme class/variables, byte-identical preview innerHTML across themes, current-only reset, save statuses, full settings-map request bodies, stale preview rejection, disabled controls during held import, restored controls afterward, and `scrollWidth <= clientWidth` at the existing mobile viewport.

- [ ] **Step 2: Run browser tests and verify RED**

Run: `node --test --test-name-pattern='工作台切换三套|每套主题独立|主题设置自动|慢的旧主题|不会重置或污染主题|主题设置在窄屏' test/typesetting.test.js`

Expected: FAIL because the workbench has no theme controls or presentation application.

- [ ] **Step 3: Add fixed controls and state synchronization**

- Add only fixed `<select>` options from the spec and a current-theme reset button.
- Keep article text inputs in the existing `fields` object; manage theme controls separately so `collect()` cannot coerce nested settings to strings.
- Add `currentThemeSettings()`, `syncThemeControls()`, and `applyPresentation(presentation)` helpers.
- On theme/setting/reset changes, update `documentModel`, increment `changeVersion`, schedule preview immediately through the existing debounce, and schedule the existing 500ms save.
- Send the current `theme` and current settings with every preview; apply HTML, class, and variables only when the response version is still current.
- Load and resync controls on startup and after import; disable all theme controls and reset during import.
- Add compact responsive layout rules in `public/style.css`; keep article theme rules exclusively in `public/typesetting-theme.css`.

- [ ] **Step 4: Run browser, import, and rich-paste regressions**

Run: `node --test --test-name-pattern='主题|导入|富文本|预览|自动保存|窄屏' test/typesetting.test.js test/typesetting-import.test.js`

Expected: all selected tests PASS, including the new theme flows and existing import/rich-paste race tests.

- [ ] **Step 5: Run the complete verification suite**

Run: `npm test`

Expected: all tests PASS with 0 fail, 0 skipped, and no external network dependency.

Run: `node --check src/typesetting.js && node --check src/typesetting-import.js && node --check src/server.js && node --check public/typesetting.js`

Run: `git diff --check origin/main..HEAD`

Expected: every command exits 0.

- [ ] **Step 6: Commit the workbench integration**

```bash
git add public/typesetting.html public/typesetting.js public/style.css test/typesetting.test.js
git commit -m "feat: add independent theme controls"
```

### Task 5: Produce the executor evidence packet

**Files:**
- Create outside the repository: `/tmp/wechat-exporter-issue-5-execution-report.md`

**Interfaces:**
- Consumes: the fixed task contract, approved spec, this plan, committed branch, and raw verification output.
- Produces: an auditable evidence packet for an independent read-only Supervisor; it does not change product files.

- [ ] **Step 1: Verify scope and repository state**

Run: `git diff --name-status origin/main..HEAD`

Expected: only the approved spec/plan and Issue #5 implementation/test/notice files appear.

Run: `git status --short --branch`

Expected: clean worktree on `codex/issue-5-themes-settings`, ahead of `origin/main`, with no untracked product files.

- [ ] **Step 2: Write the execution report**

Record each Issue #5 AC, its implementation files, exact test names, raw command summaries, commits, remaining risks, and explicit confirmation that #6–#10 were not implemented. Include the doocs commit/license/adaptation mapping and any deliberately omitted upstream selectors.

- [ ] **Step 3: Do not push or open a PR**

Stop after returning the clean HEAD and report path to the Coordinator. The Coordinator will dispatch the independent Supervisor, then manage rework, push, PR, CI, Review, merge, and main CI.
