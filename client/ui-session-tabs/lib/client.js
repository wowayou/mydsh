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
		// wide: show icon + label; collapsed rail: icon only (tooltip covers it).
		function NewTabButton(props) {
			var wide = props.wide !== false;
			var onClick = useCallback(function() {
				try { window.open(blankTabUrl(), '_blank'); } catch {}
			}, []);
			// 复用 dsh 侧栏 New Session 按钮的视觉语言：紧凑行内按钮。
			var baseStyle = {
				display: 'inline-flex', alignItems: 'center', gap: '6px',
				height: '28px', padding: wide ? '0 10px' : '0',
				border: 'none', borderRadius: '8px', cursor: 'pointer',
				background: 'transparent', font: 'inherit', fontSize: '12px',
				color: 'var(--dsw-alias-label-secondary, #9aa3b2)',
			};
			return createElement('button', {
				type: 'button', onClick: onClick,
				'aria-label': T.newTabLabel, title: T.newTabLabel,
				style: baseStyle,
			}, '⧉', wide ? createElement('span', null, T.newTab) : null);
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