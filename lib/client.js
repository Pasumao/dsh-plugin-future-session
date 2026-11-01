/**
 * dsh-plugin-future-session — 客户端半边
 *
 * 免构建浏览器 bundle（dsh 浏览器模块加载器格式，只 require react / react/jsx-runtime）。
 *
 * 两块 UI：
 *   1. 会话输入栏左下角（conversation.input.left）的「未来」滑动开关：开 = 本会话
 *      进入现实会话模式（工具调用全部由未来会话代执行），关 = 普通会话。
 *   2. **未来会话折叠框**：按插件登记的影子工具名，把同一个 ToolRow 注册进 ui-tool
 *      的 keyed slot `tool.call.toolview`。工具行里实时展示该次工具调用派生出的
 *      未来会话在干什么（按步转录，运行中自动展开、每秒轮询），收口后折叠成一行
 *      结论，用户想展开随时可以展开——即「用户看到的永远是现实会话，未来会话是
 *      可展开的折叠框」。
 *
 * 数据面：同源 fetch 到插件的 HTTP 路由（loopback-only）：
 *   GET /mode?sessionId=      → 模式 + provider 可用性
 *   PUT /mode                 → 切换模式
 *   GET /tools[?sessionId=]   → 影子工具名（keyed 视图预注册清单）
 *   GET /calls?sessionId=     → callId → 未来会话 id 索引（结果块 meta 缺失时的兜底）
 *   GET /transcript?sessionId=→ 未来会话按步转录
 *
 * @module dsh-plugin-future-session/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-future-session',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var reactJsxRuntime = require('react/jsx-runtime')
    var react = require('react')
    var jsx = reactJsxRuntime.jsx
    var jsxs = reactJsxRuntime.jsxs

    var API = '/dsh-plugin-future-session'

    // ------------------------------------------------------------------
    // 样式：一次注入 <style>，类名 dshfs-*，全部走主题 CSS 变量。
    // ------------------------------------------------------------------
    var CSS = [
      '.dshfs-wrap{position:relative;height:26px;display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none}',
      '.dshfs-wrapDisabled{cursor:default;opacity:.55}',
      '.dshfs-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.dshfs-labelOn{color:var(--dsw-alias-brand-primary,#4c8dff);font-weight:600}',
      '.dshfs-track{position:relative;width:34px;height:18px;flex-shrink:0;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,#3a3f4b);transition:background .15s ease}',
      '.dshfs-trackOn{background:var(--dsw-alias-brand-primary,#4c8dff)}',
      '.dshfs-thumb{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:999px;background:var(--dsw-alias-label-primary-inverted,#fff);box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s ease}',
      '.dshfs-thumbOn{transform:translateX(16px)}',
      '.dshfs-hint{position:absolute;bottom:calc(100% + 8px);left:0;z-index:50;width:max-content;max-width:280px;padding:6px 10px;border-radius:8px;background:var(--dsw-specific-input-major,#2a2d36);border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(255,255,255,.12));color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;pointer-events:none;opacity:0;transition:opacity .12s ease;white-space:normal}',
      '.dshfs-wrap:hover .dshfs-hint{opacity:1}',
      // ---- 折叠框 ----
      '.dshfs-box{margin:6px 0 2px;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(255,255,255,.12));border-radius:8px;background:var(--dsw-specific-input-major,#22252c);overflow:hidden;font-size:12px}',
      '.dshfs-boxHead{display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:pointer;user-select:none;color:var(--dsw-alias-label-secondary)}',
      '.dshfs-boxHead:hover{background:rgba(127,127,127,.08)}',
      '.dshfs-caret{width:12px;flex-shrink:0;opacity:.7}',
      '.dshfs-title{font-weight:600;color:var(--dsw-alias-label-primary,#e6e8ee)}',
      '.dshfs-tag{font-size:10px;padding:1px 6px;border-radius:6px;background:rgba(76,141,255,.16);color:var(--dsw-alias-brand-primary,#4c8dff);white-space:nowrap}',
      '.dshfs-tagRunning{background:rgba(240,180,60,.18);color:#e0a63a}',
      '.dshfs-tagPromote{background:rgba(120,200,140,.18);color:#5fbf7c}',
      '.dshfs-headMeta{margin-left:auto;font-size:11px;opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%}',
      '.dshfs-body{padding:2px 10px 8px;border-top:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(255,255,255,.08));max-height:340px;overflow:auto}',
      '.dshfs-step{padding:2px 0}',
      '.dshfs-stepHead{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:6px;cursor:pointer;user-select:none}',
      '.dshfs-stepHead:hover{background:rgba(127,127,127,.08)}',
      '.dshfs-stepCaret{width:10px;flex-shrink:0;opacity:.6;font-size:9px}',
      '.dshfs-stepIcon{font-size:11px;flex-shrink:0}',
      '.dshfs-stepName{font-weight:600;font-size:12px;color:var(--dsh-alias-label-primary,#e6e8ee);font-family:var(--dsw-alias-font-mono,ui-monospace,Menlo,Consolas,monospace)}',
      '.dshfs-stepNameU{color:var(--dsh-alias-label-primary,#e6e8ee)}',
      '.dshfs-stepTag{font-size:10px;padding:0 6px;border-radius:5px;background:rgba(76,141,255,.14);color:#4c8dff;white-space:nowrap}',
      '.dshfs-stepTagOk{background:rgba(95,191,124,.14);color:#5fbf7c}',
      '.dshfs-stepTagErr{background:rgba(224,104,74,.16);color:#e0684a}',
      '.dshfs-stepDesc{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}',
      '.dshfs-stepBody{margin:2px 6px 6px 22px;padding:6px 8px;border-radius:6px;background:rgba(0,0,0,.16);border:1px solid rgba(127,127,127,.12)}',
      '.dshfs-stepText{white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary,#d6d9e0);line-height:17px;font-size:11.5px;font-family:var(--dsw-alias-font-mono,ui-monospace,Menlo,Consolas,monospace);max-height:220px;overflow:auto}',
      '.dshfs-stepTextProse{font-family:inherit;font-size:12px;max-height:280px}',
      '.dshfs-stepTextReason{color:var(--dsw-alias-label-secondary);font-style:italic}',
      '.dshfs-empty{opacity:.6;padding:6px 0}',
      '.dshfs-foot{display:flex;gap:8px;align-items:center;padding:6px 10px 8px;border-top:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(255,255,255,.08))}',
      '.dshfs-btn{font-size:11px;line-height:16px;padding:2px 8px;border-radius:6px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;cursor:pointer;font-family:inherit}',
      '.dshfs-btn:hover{background:rgba(127,127,127,.12)}',
      '.dshfs-note{font-size:11px;opacity:.7}',
      '.dshfs-err{color:#e0684a}',
      // ---- 中继提问（未来会话 ask_user_* 折叠框内作答） ----
      '.dshfs-ask{margin:6px 10px;padding:8px 10px;border:1px solid rgba(76,141,255,.35);border-radius:8px;background:rgba(76,141,255,.07)}',
      '.dshfs-askTitle{font-weight:600;color:var(--dsw-alias-brand-primary,#4c8dff);font-size:12px;margin-bottom:4px}',
      '.dshfs-askQ{font-size:12px;color:var(--dsw-alias-label-primary,#e6e8ee);margin:6px 0 4px;white-space:pre-wrap}',
      '.dshfs-askOpts{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 6px}',
      '.dshfs-askOpt{font-size:11.5px;line-height:18px;padding:3px 10px;border-radius:6px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;cursor:pointer;font-family:inherit;text-align:left;max-width:100%}',
      '.dshfs-askOpt:hover{background:rgba(127,127,127,.14)}',
      '.dshfs-askOptOn{border-color:var(--dsw-alias-brand-primary,#4c8dff);background:rgba(76,141,255,.18)}',
      '.dshfs-askDesc{font-size:10.5px;opacity:.75;display:block;margin-top:1px;font-weight:400}',
      '.dshfs-askSubmit{font-size:11.5px;padding:3px 12px;border-radius:6px;border:1px solid var(--dsw-alias-brand-primary,#4c8dff);background:rgba(76,141,255,.2);color:inherit;cursor:pointer;font-family:inherit;font-weight:600}',
      '.dshfs-askDone{font-size:11px;color:#5fbf7c}'
    ].join('')
    var tagId = 'dsh-plugin-future-session/toggle.module.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-future-session'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    function fetchJson(url, options) {
      return fetch(url, options).then(function (res) {
        return res.text().then(function (text) {
          var body = null
          try { body = text === '' ? null : JSON.parse(text) } catch (e) { body = null }
          return { ok: res.ok, status: res.status, body: body }
        })
      })
    }

    // ------------------------------------------------------------------
    // 滑动开关
    // ------------------------------------------------------------------
    function FutureToggle(props) {
      var sessionId = props.sessionId
      var state = react.useState({ mode: 'normal', providerReady: true, loaded: false })
      var view = state[0]
      var setView = state[1]
      var busyState = react.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]

      react.useEffect(function () {
        if (sessionId === undefined || sessionId === null || sessionId === '') return undefined
        var alive = true
        fetchJson(API + '/mode?sessionId=' + encodeURIComponent(sessionId)).then(function (res) {
          if (alive && res.ok && res.body !== null && typeof res.body.mode === 'string') {
            setView({ mode: res.body.mode, providerReady: res.body.providerReady !== false, loaded: true })
          } else if (alive) {
            setView({ mode: 'normal', providerReady: true, loaded: true })
          }
        }).catch(function () { if (alive) setView({ mode: 'normal', providerReady: true, loaded: true }) })
        return function () { alive = false }
      }, [sessionId])

      if (sessionId === undefined || sessionId === null || sessionId === '') return null

      var on = view.mode === 'reality' || view.mode === 'reality-raw'
      var disabled = busy || !view.loaded

      function toggle() {
        if (disabled) return
        // 三态循环：普通 → 摘要返回 → 原文并入 → 普通。
        var next = view.mode === 'normal' ? 'reality' : view.mode === 'reality' ? 'reality-raw' : 'normal'
        setBusy(true)
        fetchJson(API + '/mode', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId, mode: next })
        }).then(function (res) {
          if (res.ok && res.body !== null) setView({ mode: next, providerReady: res.body.reason !== 'no-provider', loaded: true })
        }).catch(function () {}).then(function () { setBusy(false) })
      }

      var modeLabel = view.mode === 'reality-raw' ? '现实·原文' : on ? '现实·摘要' : '未来'
      var hint = !view.providerReady
        ? '核心 Agent 工厂不可用，开启后委派会失败'
        : view.mode === 'reality-raw'
          ? '原文并入模式：工具调用由未来会话代执行，其全部调用与返回值原样并入本会话（不做摘要压缩，也不需要 future_promote）。点击切回普通模式。'
          : on
            ? '摘要返回模式：本会话的任何工具调用都会在暗处 fork 一个未来会话代劳，主上下文只保留蒸馏结论。点击切换到原文并入模式。'
            : '开启后本会话成为现实会话：工具调用由未来会话代执行。第一次点击＝摘要返回，再点一次＝原文并入。点击开启。'

      return jsxs('div', {
        className: 'dshfs-wrap' + (disabled ? ' dshfs-wrapDisabled' : ''),
        role: 'switch',
        'aria-checked': on,
        'aria-label': '未来会话模式开关',
        tabIndex: 0,
        onClick: toggle,
        onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } },
        title: '现实/未来会话模式',
        children: [
          jsx('span', { className: 'dshfs-label' + (on ? ' dshfs-labelOn' : ''), children: modeLabel }),
          jsx('span', { className: 'dshfs-track' + (on ? ' dshfs-trackOn' : ''), children:
            jsx('span', { className: 'dshfs-thumb' + (on ? ' dshfs-thumbOn' : '') })
          }),
          jsx('span', { className: 'dshfs-hint', children: hint })
        ]
      })
    }

    // ------------------------------------------------------------------
    // 未来会话折叠框
    // ------------------------------------------------------------------

    /**
     * 从结果块里取未来会话 id。
     * 影子工具的 output.presentationMeta 会把 { futureSession: { childSessionId } }
     * 作为可回放展示元数据随结果持久化，客户端结果块的 meta 上就能读到。
     */
    function childIdFromBlock(block) {
      if (block === null || typeof block !== 'object') return ''
      var meta = block.meta
      if (meta === null || typeof meta !== 'object') return ''
      var future = meta.futureSession
      if (future !== null && typeof future === 'object' && typeof future.childSessionId === 'string') {
        return future.childSessionId
      }
      return ''
    }

    /** 轮询一个未来会话的按步转录（运行中 1.2s，收口后停）。挂起中继提问时持续轮询。 */
    function useTranscript(childSessionId) {
      var state = react.useState({ steps: [], info: null, running: false, error: '', loaded: false, pendingQuestion: null })
      var view = state[0]
      var setView = state[1]
      react.useEffect(function () {
        if (childSessionId === '') return undefined
        var alive = true
        var timer = null
        function tick() {
          fetchJson(API + '/transcript?sessionId=' + encodeURIComponent(childSessionId)).then(function (res) {
            if (!alive) return
            if (!res.ok || res.body === null) {
              setView({ steps: [], info: null, running: false, error: res.body && res.body.error ? res.body.error : 'http-' + res.status, loaded: true, pendingQuestion: null })
              return
            }
            setView({
              steps: Array.isArray(res.body.steps) ? res.body.steps : [],
              info: res.body.info ?? null,
              running: res.body.running === true,
              error: typeof res.body.note === 'string' ? res.body.note : '',
              loaded: true,
              pendingQuestion: res.body.pendingQuestion !== null && typeof res.body.pendingQuestion === 'object' ? res.body.pendingQuestion : null
            })
            if (res.body.running === true) timer = setTimeout(tick, 1200)
          }).catch(function () {
            if (!alive) return
            setView({ steps: [], info: null, running: false, error: '无法连接插件路由', loaded: true, pendingQuestion: null })
          })
        }
        tick()
        return function () { alive = false; if (timer !== null) clearTimeout(timer) }
      }, [childSessionId])
      return view
    }

    /** 单个转录步骤：仿原生工具行——头行（图标 + 名称 + 标签 + 描述摘要）+
     *  可折叠正文（等宽参数/结果、prose 文本、暗色思考）。 */
    function StepLine(props) {
      var step = props.step
      var text = typeof step.text === 'string' ? step.text : ''
      if (text === '' && step.kind === 'result') text = '(空结果)'

      var openState = react.useState(false)
      var open = openState[0]
      var setOpen = openState[1]

      var icon = step.kind === 'tool' ? '⚙' : step.kind === 'result' ? (step.ok === false ? '✗' : '✓') : step.kind === 'user' ? '👤' : step.kind === 'reasoning' ? '💭' : '💬'
      var name = step.kind === 'tool' ? (typeof step.name === 'string' ? step.name : '?') : step.kind === 'user' ? '用户' : step.kind === 'assistant' ? '未来会话' : step.kind === 'reasoning' ? '思考' : '结果'
      var tag = step.kind === 'tool' ? '调用' : step.kind === 'result' ? (step.ok === false ? '错误' : '完成') : null
      var tagClass = step.kind === 'result' ? (step.ok === false ? ' dshfs-stepTagErr' : ' dshfs-stepTagOk') : ''
      var desc = step.kind === 'tool' && typeof step.desc === 'string' && step.desc !== ''
        ? step.desc
        : text !== '' ? text.replace(/\s+/g, ' ').slice(0, 90) : ''

      var bodyClass = 'dshfs-stepText'
      if (step.kind === 'user' || step.kind === 'assistant') bodyClass += ' dshfs-stepTextProse'
      if (step.kind === 'reasoning') bodyClass += ' dshfs-stepTextReason'

      return jsxs('div', {
        className: 'dshfs-step',
        children: [
          jsxs('div', {
            className: 'dshfs-stepHead',
            onClick: function () { setOpen(!open) },
            children: [
              jsx('span', { className: 'dshfs-stepCaret', children: open ? '▾' : '▸' }),
              jsx('span', { className: 'dshfs-stepIcon', children: icon }),
              jsx('span', { className: 'dshfs-stepName' + (step.kind === 'user' || step.kind === 'assistant' || step.kind === 'reasoning' ? ' dshfs-stepNameU' : ''), children: name }),
              tag === null ? null : jsx('span', { className: 'dshfs-stepTag' + tagClass, children: tag }),
              desc === '' ? null : jsx('span', { className: 'dshfs-stepDesc', title: desc, children: desc })
            ]
          }),
          open && text !== '' ? jsx('div', { className: 'dshfs-stepBody', children: jsx('div', { className: bodyClass, children: text }) }) : null
        ]
      })
    }

    /**
     * 工具调用行 renderer：真实工具面在现实会话模式下的每次调用都由未来会话代执行，
     * 这里把那次未来会话包成一个折叠框。工具本身的卡片仍由内置视图负责（未被折叠框
     * 覆盖的部分），本组件只追加折叠框。
     */
    function FutureSessionToolRow(props) {
      var toolName = typeof props.toolName === 'string' ? props.toolName : ''
      var callId = typeof props.callId === 'string' ? props.callId : ''
      var sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      var resultBlock = props.phase === 'result' ? props.block : null

      var direct = childIdFromBlock(resultBlock)
      var fallbackState = react.useState('')
      var fallback = fallbackState[0]
      var setFallback = fallbackState[1]
      var childSessionId = direct !== '' ? direct : fallback

      // 兜底：结果块里没有 presentationMeta（历史会话/契约偏差）时，按 callId 查索引。
      // 0.2.1 起核心 keyed toolview 的 owner 不带会话身份（只有 callId/toolName/
      // phase/block/cwd/home），所以不带 sessionId 也能查——/calls 省略 sessionId
      // 返回全局并集，按 callId 匹配（callId 全局唯一）。**这是运行期折叠框出现的
      // 前提**：委派开始时 linkCall 先登记、收口在後，运行中查询即可命中子会话 id
      // ——0.5.1 之前 phase!=='result' 时组件直接 return null，折叠框在整个运行期
      // 从不渲染，ask 提问卡也无处出现。注册存在竞态（行挂载早于 linkCall），
      // 未命中且未收口时每 1.2s 重试（上限 30 次）。
      react.useEffect(function () {
        if (direct !== '' || callId === '') return undefined
        var alive = true
        var timer = null
        var tries = 0
        function look() {
          tries++
          var qs = sessionId !== '' ? '?sessionId=' + encodeURIComponent(sessionId) : ''
          fetchJson(API + '/calls' + qs).then(function (res) {
            if (!alive) return
            if (res.ok && res.body !== null && Array.isArray(res.body.calls)) {
              for (var i = res.body.calls.length - 1; i >= 0; i--) {
                if (res.body.calls[i].callId === callId) {
                  // 0.5.3：兜底命中/放弃打点（0.5.2 核验观察项 K：重试链命中与否
                  // 此前不可观测，两次 GUI 实弹一次命中一次空串无法定位）。
                  console.debug('[dsh-plugin-future-session] callId 兜底命中（第 ' + tries + ' 次查询）', callId)
                  setFallback(res.body.calls[i].childSessionId)
                  return
                }
              }
            }
            // 未命中：结果已落块则历史会话确实无映射，放弃；否则继续重试。
            if (props.phase !== 'result' && tries < 30) timer = setTimeout(look, 1200)
            else console.debug('[dsh-plugin-future-session] callId 兜底放弃（phase=' + props.phase + '，已试 ' + tries + ' 次）', callId)
          }).catch(function () {
            if (alive && props.phase !== 'result' && tries < 30) timer = setTimeout(look, 1200)
            else if (alive) console.debug('[dsh-plugin-future-session] callId 兜底放弃（查询失败，phase=' + props.phase + '，已试 ' + tries + ' 次）', callId)
          })
        }
        look()
        return function () { alive = false; if (timer !== null) clearTimeout(timer) }
      }, [direct, callId, sessionId, props.phase])

      var transcript = useTranscript(childSessionId)
      var expandedState = react.useState(transcript.running === true)
      var expandedAuto = expandedState[0]
      var setExpandedAuto = expandedState[1]
      var manualState = react.useState(null)
      var manual = manualState[0]
      var setManual = manualState[1]
      var expanded = manual === null ? expandedAuto : manual
      var seenRunning = react.useRef(false)

      // 运行中自动展开，收口后自动收起（用户手动操作过就不再自动改）。
      react.useEffect(function () {
        if (transcript.running === true) {
          seenRunning.current = true
          if (manual === null) setExpandedAuto(true)
        } else if (seenRunning.current && manual === null) {
          setExpandedAuto(false)
        }
      }, [transcript.running, manual])

      // 中继提问出现时强制展开（用户必须看得到才能作答）。
      var askShown = react.useRef(false)
      react.useEffect(function () {
        if (transcript.pendingQuestion !== null && !askShown.current) {
          askShown.current = true
          setManual(true)
          setExpandedAuto(true)
        }
      }, [transcript.pendingQuestion])

      if (childSessionId === '') return null
      if (props.phase === 'preparing') return null

      var decision = transcript.info && typeof transcript.info.decision === 'string' ? transcript.info.decision : null
      var running = transcript.running === true
      var tag = running ? (transcript.pendingQuestion !== null ? '等用户作答' : '运行中') : decision === 'promote' ? '已并入' : decision === 'return' ? '已回结论' : direct !== '' ? '已收口' : '已结束'
      var tagClass = running ? ' dshfs-tagRunning' : decision === 'promote' ? ' dshfs-tagPromote' : ''

      var steps = transcript.steps
      // 框头「结论摘要」：取最后一条非空 result/assistant 文本（0.5.1 只取
      // assistant——收口前最后一条 assistant 往往是被 JSON 序列化的 tool-call
      // 噪音，或干脆为空，摘要取到的是乱码/空白）。
      var lastText = ''
      for (var i = steps.length - 1; i >= 0; i--) {
        if ((steps[i].kind === 'result' || steps[i].kind === 'assistant') && typeof steps[i].text === 'string' && steps[i].text !== '') { lastText = steps[i].text; break }
      }
      var headMeta = lastText !== '' ? lastText.replace(/\s+/g, ' ').slice(0, 80) : childSessionId

      var body = []
      if (expanded) {
        if (transcript.pendingQuestion !== null) {
          body.push(jsx(AskRelayCard, { childSessionId: childSessionId, pendingQuestion: transcript.pendingQuestion }, 'ask'))
        }
        body.push(jsx('div', { className: 'dshfs-body', children:
          steps.length === 0
            ? jsx('div', { className: 'dshfs-empty', children: transcript.loaded ? '（未来会话暂无步骤）' : '读取中…' })
            : steps.map(function (step, index) { return jsx(StepLine, { step: step }, String(index)) })
        }, 'body'))
        if (transcript.error !== '') body.push(jsx('div', { className: 'dshfs-foot', children: jsx('span', { className: 'dshfs-note dshfs-err', children: transcript.error }) }, 'err'))
      }

      var foot = jsxs('div', {
        className: 'dshfs-foot',
        children: [
          jsx('button', {
            className: 'dshfs-btn',
            onClick: function (e) {
              e.stopPropagation()
              try {
                if (navigator.clipboard) navigator.clipboard.writeText(childSessionId)
              } catch (error) { /* 剪贴板不可用就算了 */ }
            },
            children: '复制会话 id'
          }),
          decision === 'promote'
            ? jsx('span', { className: 'dshfs-note', children: '已并入：该未来会话的过程已合并进现实会话上下文，现实会话继续推进。' })
            : jsx('span', { className: 'dshfs-note', children: childSessionId })
        ]
      }, 'foot')

      return jsxs('div', {
        className: 'dshfs-box',
        children: [
          jsxs('div', {
            className: 'dshfs-boxHead',
            onClick: function () { setManual(expanded ? false : true) },
            children: [
              jsx('span', { className: 'dshfs-caret', children: expanded ? '▾' : '▸' }),
              jsx('span', { className: 'dshfs-title', children: '未来会话' }),
              jsx('span', { className: 'dshfs-tag' + tagClass, children: tag }),
              jsx('span', { className: 'dshfs-headMeta', title: headMeta, children: headMeta })
            ]
          }, 'head'),
          expanded ? body : null,
          expanded ? foot : null
        ]
      })
    }

    // ------------------------------------------------------------------
    // 中继提问卡：未来会话挂起等用户作答时渲染在折叠框里
    // ------------------------------------------------------------------

    function AskRelayCard(props) {
      var childSessionId = props.childSessionId
      var pending = props.pendingQuestion
      var onDone = props.onDone
      var submitState = react.useState('')
      var submitted = submitState[0]
      var setSubmitted = submitState[1]
      var pickState = react.useState({})
      var picks = pickState[0]
      var setPicks = pickState[1]

      var questions = pending !== null && pending !== undefined && Array.isArray(pending.questions) ? pending.questions : []

      function togglePick(qid, label, multi) {
        var next = Object.assign({}, picks)
        var key = qid
        if (multi === true) {
          var cur = Array.isArray(next[key]) ? next[key].slice() : []
          var idx = cur.indexOf(label)
          if (idx === -1) cur.push(label); else cur.splice(idx, 1)
          next[key] = cur
        } else {
          next[key] = next[key] === label ? undefined : label
        }
        setPicks(next)
      }

      function submit() {
        var answers = {}
        var complete = true
        for (var i = 0; i < questions.length; i++) {
          var q = questions[i]
          var v = picks[q.id]
          if (v === undefined || (Array.isArray(v) && v.length === 0)) { complete = false; continue }
          answers[q.id] = v
        }
        if (!complete) { setSubmitted('还有未作答的问题'); return }
        setSubmitted('sending')
        fetchJson(API + '/answer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ childSessionId: childSessionId, answers: answers })
        }).then(function (res) {
          if (res.ok && res.body !== null && res.body.ok === true) setSubmitted('done')
          else setSubmitted(res.body && res.body.error ? res.body.error : 'http-' + res.status)
        }).catch(function () { setSubmitted('无法连接插件路由') })
        if (typeof onDone === 'function') onDone()
      }

      return jsxs('div', { className: 'dshfs-ask', children: [
        jsx('div', { className: 'dshfs-askTitle', children: '🔔 未来会话正在提问（作答后它原地继续）' }),
        questions.map(function (q, qi) {
          var options = Array.isArray(q.options) ? q.options : []
          var multi = q.multi_select === true
          return jsxs('div', { key: String(q.id !== undefined ? q.id : qi), children: [
            jsx('div', { className: 'dshfs-askQ', children: (typeof q.header === 'string' && q.header !== '' ? q.header + '：' : '') + (typeof q.question === 'string' ? q.question : '') + (multi ? '（可多选）' : '') }),
            jsx('div', { className: 'dshfs-askOpts', children: options.map(function (o, oi) {
              var label = typeof o.label === 'string' ? o.label : String(oi)
              var on = multi === true
                ? Array.isArray(picks[q.id]) && picks[q.id].indexOf(label) !== -1
                : picks[q.id] === label
              return jsx('button', {
                type: 'button',
                className: 'dshfs-askOpt' + (on ? ' dshfs-askOptOn' : ''),
                onClick: function () { togglePick(q.id, label, multi) },
                children: typeof o.description === 'string' && o.description !== ''
                  ? jsxs('span', { children: [label, jsx('span', { className: 'dshfs-askDesc', children: o.description })] })
                  : label
              }, label)
            }) })
          ] })
        }),
        submitted === 'done'
          ? jsx('div', { className: 'dshfs-askDone', children: '✓ 已作答，未来会话继续执行中' })
          : submitted === 'sending'
            ? jsx('div', { className: 'dshfs-note', children: '提交中…' })
            : submitted !== '' && submitted !== 'sending'
              ? jsxs('div', { className: 'dshfs-note dshfs-err', children: ['提交失败：', submitted, ' '] })
              : jsx('button', { type: 'button', className: 'dshfs-askSubmit', onClick: submit, children: '提交作答' })
      ] })
    }

    /**
     * 影子工具清单（客户端 keyed 视图预注册用）。
     * `ctx.slots.register` 的贡献在插件生命周期内**单调不可撤销**，所以必须离线知道
     * 工具名；这份只放核心官方**没有**内置 toolview 的工具名（0.4.1：原全集与
     * ui-tool / ui-deliverables / ui-skill 的 key 大面积相撞，keyed slot 同 key 同
     * priority 的重复注册会直接 throw，把官方 entry 炸成 FAILED → 白屏启动失败），
     * 运行时再用 GET /tools 的实测清单补齐（同样只收官方未占用的 key）。
     */
    var STATIC_TOOL_NAMES = [
      'exit_plan_mode', 'list_mcp_resources', 'list_mcp_resource_templates',
      'load_workspace_dependencies', 'pwsh', 'read_mcp_resource', 'run_code',
      'str_replace_editor', 'subagent_fork', 'terminal_send'
    ]

    /** 核心 client-ui 各 entry 已注册进 `tool.call.toolview` 的 key（0.2.0-rc.2 实测）。 */
    var CORE_TOOLVIEW_KEYS = [
      'ask_user_question', 'bash', 'cordis_define', 'cordis_inspect_list', 'cordis_inspect_query',
      'cordis_inspect_self', 'cordis_run', 'cordis_stop', 'cordis_undefine', 'create_goal', 'edit',
      'get_goal', 'glob', 'grep', 'interrupt_agent', 'job_kill', 'job_list', 'job_output',
      'list_agents', 'list_subagent_models', 'lsp', 'present', 'ralph', 'read', 'read_image',
      'schedule_create', 'schedule_delete', 'schedule_list', 'schedule_update', 'send_message',
      'session_event_read', 'session_event_search', 'session_event_trace', 'session_search',
      'session_trace', 'skill', 'spawn_teammate', 'subagent', 'team_task_create', 'team_task_get',
      'team_task_list', 'team_task_update', 'terminal_close', 'terminal_list', 'terminal_open',
      'terminal_read', 'terminal_signal', 'todo_write', 'update_goal', 'wait_agent', 'web_fetch',
      'web_search', 'workflow', 'write'
    ]
    var coreKeys = {}
    for (var ci = 0; ci < CORE_TOOLVIEW_KEYS.length; ci++) coreKeys[CORE_TOOLVIEW_KEYS[ci]] = true

    function apply(ctx) {
      ctx.slots.inject('conversation.input.left', function () {
        return ctx.slots.register({
          name: 'conversation.input.left',
          id: 'future-toggle',
          order: 41
        }, FutureToggle)
      })

      // 折叠框：开启「现实会话」后真实工具会被同名影子工具遮蔽，因此按工具名把同一个
      // ToolRow 挂到 ui-tool 的 keyed slot `tool.call.toolview`（未登记的工具继续用内置
      // 视图）。注册单调不可撤销 → 静态清单 + 运行时补齐，且每个名字只注册一次。
      // 冲突防御：官方 entry 同 key 同 priority 的注册会 throw 并把它的 fiber 炸成
      // FAILED（启动白屏），所以这里绝不和官方抢 key—— CORE 名单直接跳过，兜底
      // try/catch 吞掉残余冲突（官方视图优先，折叠框退化为不显示）。
      var registered = {}
      function registerKey(key) {
        if (typeof key !== 'string' || key === '' || registered[key] === true) return
        if (coreKeys[key] === true) return
        registered[key] = true
        try {
          ctx.slots.register({
            name: 'tool.call.toolview',
            key: key
          }, FutureSessionToolRow)
        } catch (error) { /* key 已被官方（或更高优先级贡献者）占用：保留官方视图 */ }
      }
      ctx.slots.inject('tool.call.toolview', function () {
        // 1) 先同步注册静态清单：owner 每次重新挂载都会重跑本回调，幂等靠 registered。
        for (var i = 0; i < STATIC_TOOL_NAMES.length; i++) registerKey(STATIC_TOOL_NAMES[i])
        // 2) 再用实测清单补齐（新增插件工具等）。
        var alive = true
        fetchJson(API + '/tools').then(function (res) {
          if (!alive || !res.ok || res.body === null || !Array.isArray(res.body.tools)) return
          for (var j = 0; j < res.body.tools.length; j++) registerKey(res.body.tools[j])
        }).catch(function () {})
        return function () { alive = false }
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.FutureToggle = FutureToggle
    exports.FutureSessionToolRow = FutureSessionToolRow
    exports.AskRelayCard = AskRelayCard
    return module.exports
  }
})
