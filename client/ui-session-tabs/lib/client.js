// mydsh ui-session-tabs — browser-side: open session in new tab + URL deep-linking.
//
// Two pieces:
// 1. "Open in new tab" button in conversation.chat.assistant-actions (the three-dots menu
//    on each assistant message). Uses sessionId from PropsRuntime framework kit.
// 2. URL session opener: null component in conversation.input.dock that reads
//    ?session=<id> from the URL and opens the matching session.
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
		const T = isZh()
			? { openTab: '在新标签页打开本会话（链接已复制）', copied: '✓' }
			: { openTab: 'Open this session in a new tab (link copied)', copied: '✓' };

		/** Build deep link: current URL + ?session=<id>. */
		function deepLink(sessionId) {
			try {
				const u = new URL(window.location.href);
				u.searchParams.set('session', String(sessionId));
				return u.toString();
			} catch {
				return window.location.href.split('#')[0] + '?session=' + encodeURIComponent(String(sessionId));
			}
		}

		/** "Open in new tab" button for the assistant message action strip. */
		function OpenTabAction(props) {
			const sessionId = props.sessionId;
			const [copied, setCopied] = useState(false);
			const timer = useRef(undefined);

			useEffect(() => () => {
				if (timer.current !== undefined) clearTimeout(timer.current);
			}, []);

			const onClick = useCallback(() => {
				const url = deepLink(sessionId);
				try {
					if (navigator.clipboard && navigator.clipboard.writeText) {
						navigator.clipboard.writeText(url).catch(() => {});
					}
				} catch {}
				try { window.open(url, '_blank'); } catch {}
				setCopied(true);
				if (timer.current !== undefined) clearTimeout(timer.current);
				timer.current = setTimeout(() => setCopied(false), 1500);
			}, [sessionId]);

			return createElement('button', {
				title: T.openTab,
				onClick: onClick,
				style: {
					background: 'transparent', border: 'none', cursor: 'pointer',
					color: copied ? 'var(--dsw-alias-state-success-primary, #3fae6a)' : 'var(--dsw-alias-label-secondary, #9aa3b2)',
					fontSize: '12px', padding: '2px 6px', borderRadius: 6,
				},
			}, copied ? T.copied : '⧉');
		}

		/** URL session opener: null component, opens session from ?session=<id>. */
		function UrlSessionOpener(props) {
			const useSessions = props.useSessions;
			const sessions = props.sessions;
			const target = useMemo(() => {
				try { return new URLSearchParams(window.location.search).get('session'); } catch { return null; }
			}, []);
			const listed = useSessions((s) => s && s.phase === 'ready' && target !== null && s.ids.indexOf(target) !== -1);
			const opened = useRef(false);
			useEffect(() => {
				if (!listed || opened.current || sessions === undefined || sessions === null) return;
				opened.current = true;
				try { sessions.open(target); } catch {}
			}, [listed, target, sessions]);
			return null;
		}

		module.exports = {
			name: '@mydsh/ui-session-tabs',
			inject: ['slots', 'sessions'],
			apply(ctx) {
				const sessions = ctx.get('sessions');
				const slots = ctx.get('slots');
				if (slots === undefined) return;
				// 1. "Open in new tab" button in assistant message actions (three dots menu)
				ctx.effect(
					() => slots.inject('conversation.chat.assistant-actions', () => slots.register({
						name: 'conversation.chat.assistant-actions',
						id: 'mydsh-open-tab',
						order: 5,
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
			},
		};
		return module.exports;
	}
});