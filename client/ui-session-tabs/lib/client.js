// mydsh ui-session-tabs — browser-side: open session in new tab + URL deep-linking.
//
// Three pieces:
// 1. "Open in new tab" button in conversation.session.header.actions
//    (the session header action row — the three-dots area on each session).
//    Uses sessionId from PropsRuntime framework kit.
// 2. URL session opener: null component in conversation.input.dock that reads
//    ?session=<id> from the URL and opens the matching session.
// 3. "New session in new tab" button in sidebar.footer.action: opens a fresh
//    tab WITHOUT ?session= so the new tab initializes a blank New Session via
//    the standard startInitialSelection flow (not a deep link to an existing
//    session). Sits beside Settings at the sidebar foot.
//
// Hand-written __ModuleLoader__ bundle (zero build deps): only requires react.
window.__ModuleLoader__.load({
	id: '@mydsh/ui-session-tabs',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require('react');
		const { useState, useEffect, useMemo, useRef, useCallback, createElement } = React;

		function isZh() {
			try { return (navigator.language || '').toLowerCase().startsWith('zh'); } catch { return false; }
		}
		var T = isZh()
			? { openTab: '在新标签页打开本会话（链接已复制）', copied: '✓',
			    newTabLabel: '在新标签页新建会话', newTab: '新建' }
			: { openTab: 'Open this session in a new tab (link copied)', copied: '✓',
			    newTabLabel: 'New session in a new tab', newTab: 'New' };

		function deepLink(sessionId) {
			try {
				var u = new URL(window.location.href);
				u.searchParams.set('session', String(sessionId));
				return u.toString();
			} catch {
				return window.location.href.split('#')[0] + '?session=' + encodeURIComponent(String(sessionId));
			}
		}

		/** 当前页面 URL 去掉 ?session= 参数后的地址：新标签页打开它即等于
		 *  「新建会话」（走 startInitialSelection，不指向任何已存在会话）。 */
		function blankTabUrl() {
			try {
				var u = new URL(window.location.href);
				u.searchParams.delete('session');
				return u.toString();
			} catch {
				return window.location.href.split('#')[0].split('?')[0];
			}
		}

		// "Open in new tab" button for the session header action row.
		function OpenTabAction(props) {
			var sessionId = props.sessionId;
			var state = useState(false);
			var copied = state[0]; var setCopied = state[1];
			var timer = useRef(undefined);

			useEffect(function() { return function() {
				if (timer.current !== undefined) clearTimeout(timer.current);
			}; }, []);

			var onClick = useCallback(function() {
				var url = deepLink(sessionId);
				try {
					if (navigator.clipboard && navigator.clipboard.writeText) {
						navigator.clipboard.writeText(url).catch(function() {});
					}
				} catch {}
				try { window.open(url, '_blank'); } catch {}
				setCopied(true);
				if (timer.current !== undefined) clearTimeout(timer.current);
				timer.current = setTimeout(function() { setCopied(false); }, 1500);
			}, [sessionId]);

			return createElement('button', {
				title: T.openTab,
				onClick: onClick,
				style: {
					background: 'transparent', border: 'none', cursor: 'pointer',
					color: copied ? 'var(--dsw-alias-state-success-primary, #3fae6a)' : 'var(--dsw-alias-label-secondary, #9aa3b2)',
					fontSize: '14px', padding: '2px 6px', borderRadius: 6, lineHeight: 1,
				},
			}, copied ? T.copied : '⧉');
		}

		// URL session opener: null component, opens session from ?session=<id>.
		function UrlSessionOpener(props) {
			var useSessions = props.useSessions;
			var sessions = props.sessions;
			var target = useMemo(function() {
				try { return new URLSearchParams(window.location.search).get('session'); } catch { return null; }
			}, []);
			var listed = useSessions(function(s) { return s && s.phase === 'ready' && target !== null && s.ids.indexOf(target) !== -1; });
			var opened = useRef(false);
			useEffect(function() {
				if (!listed || opened.current || sessions === undefined || sessions === null) return;
				opened.current = true;
				try { sessions.open(target); } catch {}
			}, [listed, target, sessions]);
			return null;
		}

		// "New session in new tab" button for the sidebar footer action slot.
		// 视觉完全对齐 DSH footer 的 Settings trigger（figma sidebar foot）：
		//   34px 高 / 12px 圆角 / 透明 + hover interactive-bg-hover / 14px label-primary /
		//   16px 线条图标（与顶部 New Session 同款 ic_ds_new_chat_outline_16 path）。
		// wide: 图标 + 文字；折叠 rail: 36px 圆形只留图标（与 Settings 折叠态一致）。
		// 手写 bundle 无 CSS Modules，hover 背景用 React state 模拟。
		var NEW_CHAT_ICON_PATH =
			'M8.00003 0.3237C3.76075 0.3237 0.32373 3.76072 0.32373 8C0.32373 9.17603 0.589121 10.2922 1.0632 11.2901L1.35291 11.8989L2.5705 11.3205L2.28079 10.7117C1.89079 9.89074 1.67301 8.97167 1.67301 8C1.67301 4.50546 4.50549 1.67298 8.00003 1.67298C11.4946 1.67298 14.3271 4.50546 14.3271 8C14.3271 11.4945 11.4946 14.327 8.00003 14.327C7.28473 14.327 6.76077 14.277 6.29621 14.1487C5.83857 14.0224 5.40441 13.8109 4.88514 13.4488C4.12569 12.919 3.03778 12.7316 2.141 13.2978L2.12682 13.307L2.11264 13.3171L1.34886 13.854L1.79659 15.188L2.86122 14.4384C3.19068 14.2305 3.68325 14.2542 4.11326 14.5539C4.72789 14.9826 5.30042 15.2724 5.93762 15.4484C6.56803 15.6224 7.22776 15.6763 8.00003 15.6763C12.2393 15.6763 15.6763 12.2393 15.6763 8C15.6763 3.76072 12.2393 0.3237 8.00003 0.3237ZM7.32033 4.82535V7.32536H4.82538V8.67464H7.32033V11.1747H8.6696V8.67464H11.1747V7.32536H8.6696V4.82535H7.32033Z';

		function NewChatIcon() {
			return createElement('svg', {
				width: 16, height: 16, viewBox: '0 0 16 16',
				fill: 'none', xmlns: 'http://www.w3.org/2000/svg',
				'aria-hidden': true, style: { flexShrink: 0 },
			}, createElement('path', { d: NEW_CHAT_ICON_PATH, fill: 'currentColor' }));
		}

		function NewTabButton(props) {
			var wide = props.wide !== false;
			var hovered = useState(false);
			var isHovered = hovered[0]; var setHovered = hovered[1];
			var onClick = useCallback(function() {
				try { window.open(blankTabUrl(), '_blank'); } catch {}
			}, []);
			// 与 SettingsRoot.module.css .trigger 对齐；rail 时对齐 .trigger.rail。
			var baseStyle = {
				flex: 'none',
				display: 'inline-flex', alignItems: 'center', gap: '8px',
				boxSizing: 'border-box',
				width: wide ? 'auto' : '36px',
				height: wide ? '34px' : '36px',
				margin: wide ? '4px -4px 4px' : '8px 0 10px',
				padding: wide ? '6px 2px 6px 10px' : '0',
				justifyContent: wide ? 'flex-start' : 'center',
				border: 'none',
				borderRadius: wide ? '12px' : '50%',
				background: isHovered ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.08))' : 'transparent',
				cursor: 'pointer',
				overflow: 'hidden',
				color: 'var(--dsw-alias-label-primary, #e6e9ef)',
				font: 'inherit', fontSize: '14px', lineHeight: '22px',
			};
			return createElement('button', {
				type: 'button',
				onClick: onClick,
				onMouseEnter: function() { setHovered(true); },
				onMouseLeave: function() { setHovered(false); },
				'aria-label': T.newTabLabel, title: T.newTabLabel,
				style: baseStyle,
			}, createElement(NewChatIcon, {}),
				wide ? createElement('span', { style: { overflow: 'hidden', whiteSpace: 'nowrap' } }, T.newTab) : null);
		}

		module.exports = {
			name: '@mydsh/ui-session-tabs',
			inject: ['slots', 'sessions'],
			apply(ctx) {
				var sessions = ctx.get('sessions');
				var slots = ctx.get('slots');
				if (slots === undefined) return;
				// 1. "Open in new tab" button in session header actions (three dots area)
				ctx.effect(
					() => slots.inject('conversation.session.header.actions', () => slots.register({
						name: 'conversation.session.header.actions',
						id: 'mydsh-open-tab',
						order: 30,
					}, OpenTabAction)),
					'@mydsh/ui-session-tabs: open-tab action',
				);
				// 2. URL session opener (null component in input dock)
				ctx.effect(
					() => slots.inject('conversation.input.dock', (ownerProps) => slots.register({
						name: 'conversation.input.dock',
						id: 'mydsh-url-session',
						order: 50,
					}, (props) => UrlSessionOpener({ ...props, sessions }))),
					'@mydsh/ui-session-tabs: url opener',
				);
				// 3. "New session in new tab" button at the sidebar foot (beside Settings).
				//    Opening a tab WITHOUT ?session= makes the new tab initialize a blank
				//    New Session through startInitialSelection — no deep link, no existing
				//    session — which is exactly "new session from a new tab".
				ctx.effect(
					() => slots.inject('sidebar.footer.action', (ownerProps) => slots.register({
						name: 'sidebar.footer.action',
						id: 'mydsh-new-tab',
						order: 0,
					}, () => NewTabButton({ wide: ownerProps && ownerProps.wide }))),
					'@mydsh/ui-session-tabs: new-tab footer action',
				);
			},
			// 供 tests 直接驱动的纯逻辑（不参与运行时）。
			__test: { deepLink, blankTabUrl },
		};
		return module.exports;
	}
});