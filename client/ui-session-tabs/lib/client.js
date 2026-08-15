// mydsh ui-session-tabs — 浏览器半边：多会话「新标签页打开」。
//
// 手写 __ModuleLoader__ bundle（零构建依赖）：只 require 平台模块表里的 react。
// 机制：
//   1. 会话头注册「⧉」按钮：把当前会话的深链 `?session=<id>` 复制到剪贴板并
//      在新标签页打开。每个标签页的会话选择存在各自的内存态里（localStorage
//      只是重载种子），互不干扰。
//   2. 页面加载时读 `?session=`：等会话列表就绪且包含目标后 `sessions.open(id)`，
//      实现「不同标签页访问同一地址、各选各的会话」。
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
			? { openTab: '在新标签页打开本会话（链接已复制）', copied: '已复制', open: '在新标签页打开' }
			: { openTab: 'Open this session in a new tab (link copied)', copied: 'Copied', open: 'Open in new tab' };

		/** 组装深链：当前地址 + ?session=<id>（保留其它参数）。 */
		function deepLink(sessionId) {
			try {
				const u = new URL(window.location.href);
				u.searchParams.set('session', String(sessionId));
				return u.toString();
			} catch {
				return window.location.href.split('#')[0] + '?session=' + encodeURIComponent(String(sessionId));
			}
		}

		/** 会话头按钮：复制深链 + 新标签页打开。 */
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
					fontSize: '13px', padding: '2px 6px', borderRadius: 6,
				},
			}, copied ? '✓' : '⧉');
		}

		/** 深链打开器：渲染 null，加载时按 URL 选择会话。sessions 服务经 apply 闭包注入。 */
		function UrlSessionOpener(props) {
			const useSessions = props.useSessions;
			const sessions = props.sessions;
			const target = useMemo(() => {
				try { return new URLSearchParams(window.location.search).get('session'); } catch { return null; }
			}, []);
			// 等待列表 ready 且包含目标（phase: 'pending' | 'ready'）。
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
				ctx.effect(
					() => slots.inject('conversation.session.header.actions', () => slots.register({
						name: 'conversation.session.header.actions',
						id: 'mydsh-open-tab',
						order: 30,
					}, OpenTabAction)),
					'@mydsh/ui-session-tabs: open-tab action',
				);
				ctx.effect(
					() => slots.inject('conversation.session.header.actions', () => slots.register({
						name: 'conversation.session.header.actions',
						id: 'mydsh-url-session',
						order: 40,
					}, UrlSessionOpener)),
					'@mydsh/ui-session-tabs: url opener',
				);
			},
		};
		return module.exports;
	}
});