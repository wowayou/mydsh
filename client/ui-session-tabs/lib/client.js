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
			    newTabLabel: '在新标签页新建会话', newTab: '新建',
			    workspacePick: '选择工作区' }
			: { openTab: 'Open this session in a new tab (link copied)', copied: '✓',
			    newTabLabel: 'New session in a new tab', newTab: 'New',
			    workspacePick: 'Choose a workspace' };

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
		//
		// 行为：点击弹出 workspace 选择框（浮层），选一个 workspace 后
		// connectWorkspace(id) 拿到（复用或新建的）会话 id，再在新标签页深链打开。
		// 没有 workspace 可选项时退化为「打开空标签页」（新标签页自己初始化）。
		var NEW_CHAT_ICON_PATH =
			'M8.00003 0.3237C3.76075 0.3237 0.32373 3.76072 0.32373 8C0.32373 9.17603 0.589121 10.2922 1.0632 11.2901L1.35291 11.8989L2.5705 11.3205L2.28079 10.7117C1.89079 9.89074 1.67301 8.97167 1.67301 8C1.67301 4.50546 4.50549 1.67298 8.00003 1.67298C11.4946 1.67298 14.3271 4.50546 14.3271 8C14.3271 11.4945 11.4946 14.327 8.00003 14.327C7.28473 14.327 6.76077 14.277 6.29621 14.1487C5.83857 14.0224 5.40441 13.8109 4.88514 13.4488C4.12569 12.919 3.03778 12.7316 2.141 13.2978L2.12682 13.307L2.11264 13.3171L1.34886 13.854L1.79659 15.188L2.86122 14.4384C3.19068 14.2305 3.68325 14.2542 4.11326 14.5539C4.72789 14.9826 5.30042 15.2724 5.93762 15.4484C6.56803 15.6224 7.22776 15.6763 8.00003 15.6763C12.2393 15.6763 15.6763 12.2393 15.6763 8C15.6763 3.76072 12.2393 0.3237 8.00003 0.3237ZM7.32033 4.82535V7.32536H4.82538V8.67464H7.32033V11.1747H8.6696V8.67464H11.1747V7.32536H8.6696V4.82535H7.32033Z';

		function NewChatIcon() {
			return createElement('svg', {
				width: 16, height: 16, viewBox: '0 0 16 16',
				fill: 'none', xmlns: 'http://www.w3.org/2000/svg',
				'aria-hidden': true, style: { flexShrink: 0 },
			}, createElement('path', { d: NEW_CHAT_ICON_PATH, fill: 'currentColor' }));
		}

		// DSH 同款 ic_ds_folder_close_16 path（菜单项 leading 图标，workspace 语义）。
		var FOLDER_ICON_PATH =
			'M5.05582 0.518756L4.50669 0.86654L5.05582 0.518756ZM13 9.4837L13.65 9.4837L13.65 3.53962L13 3.53962L12.35 3.53962L12.35 9.4837L13 9.4837ZM11.3264 1.86603L11.3264 1.21603L6.52313 1.21603L6.52313 1.86603L6.52313 2.51603L11.3264 2.51603L11.3264 1.86603ZM5.58054 1.34727L6.12968 0.999489L5.60495 0.170972L5.05582 0.518756L4.50669 0.86654L5.03141 1.69506L5.58054 1.34727ZM4.11323 1.23058e-13L4.11323 -0.65L1.67359 -0.65L1.67359 5.00699e-14L1.67359 0.65L4.11323 0.65L4.11323 1.23058e-13ZM0 1.67359L-0.65 1.67359L-0.65 9.4837L0 9.4837L0.65 9.4837L0.65 1.67359L0 1.67359ZM11.3264 11.1573L11.3264 10.5073L1.67359 10.5073L1.67359 11.1573L1.67359 11.8073L11.3264 11.8073L11.3264 11.1573ZM0 9.4837L-0.65 9.4837C-0.65 10.767 0.390308 11.8073 1.67359 11.8073L1.67359 11.1573L1.67359 10.5073C1.10828 10.5073 0.65 10.049 0.65 9.4837L0 9.4837ZM1.67359 5.00699e-14L1.67359 -0.65C0.390307 -0.65 -0.65 0.390309 -0.65 1.67359L0 1.67359L0.65 1.67359C0.65 1.10828 1.10828 0.65 1.67359 0.65L1.67359 5.00699e-14ZM5.05582 0.518756L5.60495 0.170972C5.28121 -0.340193 4.71829 -0.65 4.11323 -0.65L4.11323 1.23058e-13L4.11323 0.65C4.27282 0.65 4.4213 0.731715 4.50669 0.86654L5.05582 0.518756ZM6.52313 1.86603L6.52313 1.21603C6.36354 1.21603 6.21507 1.13431 6.12968 0.999489L5.58054 1.34727L5.03141 1.69506C5.35515 2.20622 5.91808 2.51603 6.52313 2.51603L6.52313 1.86603ZM13 3.53962L13.65 3.53962C13.65 2.25634 12.6097 1.21603 11.3264 1.21603L11.3264 1.86603L11.3264 2.51603C11.8917 2.51603 12.35 2.97431 12.35 3.53962L13 3.53962ZM13 9.4837L12.35 9.4837C12.35 10.049 11.8917 10.5073 11.3264 10.5073L11.3264 11.1573L11.3264 11.8073C12.6097 11.8073 13.65 10.767 13.65 9.4837L13 9.4837Z';

		function FolderIcon() {
			return createElement('svg', {
				width: 16, height: 16, viewBox: '0 0 16 16',
				fill: 'none', xmlns: 'http://www.w3.org/2000/svg',
				'aria-hidden': true,
			}, createElement('path', { transform: 'translate(1.5 2.429)', d: FOLDER_ICON_PATH, fill: 'currentColor' }));
		}

		// ── workspace 选择纯逻辑（可测） ─────────────────────────────────

		/** workspaces.list 快照 → 选择框选项 [{id, title, path}]（按列表顺序）。 */
		function workspaceChoices(list) {
			try {
				var items = (list && list.items) || [];
				return items.map(function(w) {
					return { id: w.workspaceId, title: w.title, path: w.path };
				});
			} catch { return []; }
		}

		/**
		 * 在指定 workspace 下新建会话并打开新标签页。
		 * @returns 'opened' | 'fallback' | 'error'
		 *   - 'opened': connectWorkspace 成功，已 window.open 深链
		 *   - 'fallback': 无 workspace 可选 / 无 workspaces 服务，退化为打开空标签页
		 *   - 'error': connectWorkspace 失败（已在 console 记录）
		 */
		function openNewTabInWorkspace(workspaces, workspaceId, win) {
			var w = win || (typeof window !== 'undefined' ? window : null);
			// 无目标 workspace 或服务缺失：打开空标签页，让新标签页自己初始化。
			if (!workspaces || typeof workspaces.connectWorkspace !== 'function' || workspaceId == null) {
				try { if (w) w.open(blankTabUrl(), '_blank'); } catch {}
				return 'fallback';
			}
			try {
				workspaces.connectWorkspace(workspaceId).then(function(sessionId) {
					try { if (w) w.open(deepLink(sessionId), '_blank'); } catch {}
				}, function(reason) {
					try { console.warn('mydsh: new tab in workspace failed:', reason); } catch {}
				});
				return 'opened';
			} catch (error) {
				try { console.warn('mydsh: connectWorkspace threw:', error); } catch {}
				return 'error';
			}
		}

		// ── NewTabButton 组件 ───────────────────────────────────────────
		// 视觉规范见 docs/design-language.md（DSH 设计令牌提取）：
		//  - 按钮对齐 Settings trigger（34px/12px/14px/hover interactive-bg-hover）
		//  - 选择框浮层完全复刻 DSH Menu：
		//      卡片: --dsw-specific-menu 底 / --dsw-alias-border-inverted 描边 /
		//            --dsw-shadow-lv3 / r12 / 4px pad / min-width 218
		//      菜单项: min-h 40 / r10 / pad 8 10 / 14-22 / label-primary /
		//            hover interactive-bg-hover / 16px 图标槽 / label ellipsis
		//      头部: 12-16 / label-tertiary / pad 8 10
		//      4px gap（bottom: calc(100% + 4px)）

		function NewTabButton(props) {
			var wide = props.wide !== false;
			var workspaces = props.workspaces;
			var hovered = useState(false);
			var isHovered = hovered[0]; var setHovered = hovered[1];
			var menuOpen = useState(false);
			var isOpen = menuOpen[0]; var setOpen = menuOpen[1];
			var anchorRef = useRef(null);

			// 选择框内容：workspace 列表快照（打开时取一次）。
			var choices = isOpen ? workspaceChoices(workspaces && workspaces.list ? workspaces.list.getSnapshot() : null) : [];

			var onPick = useCallback(function(id) {
				setOpen(false);
				openNewTabInWorkspace(workspaces, id);
			}, [workspaces]);

			var onToggle = useCallback(function() {
				// 无 workspace 可选项：直接打开空标签页（新标签页自己初始化），不弹空框。
				var list = workspaces && workspaces.list ? workspaces.list.getSnapshot() : null;
				var opts = workspaceChoices(list);
				if (opts.length === 0) {
					openNewTabInWorkspace(workspaces, null);
					return;
				}
				setOpen(function(v) { return !v; });
			}, [workspaces]);

			// 点击外部关闭 + Escape 关闭：全局监听（挂载时注册，对齐 Menu.tsx）。
			useEffect(function() {
				if (!isOpen) return;
				var onDown = function(e) {
					try {
						if (anchorRef.current && anchorRef.current.contains(e.target)) return;
						setOpen(false);
					} catch {}
				};
				var onKey = function(e) {
					try { if (e.key === 'Escape') setOpen(false); } catch {}
				};
				try { document.addEventListener('pointerdown', onDown); } catch {}
				try { document.addEventListener('keydown', onKey); } catch {}
				return function() {
					try { document.removeEventListener('pointerdown', onDown); } catch {}
					try { document.removeEventListener('keydown', onKey); } catch {}
				};
			}, [isOpen]);

			// 按钮：对齐 SettingsRoot.module.css .trigger（rail 对齐 .trigger.rail）。
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
				background: isHovered || isOpen ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
				cursor: 'pointer',
				overflow: 'hidden',
				color: 'var(--dsw-alias-label-primary)',
				font: 'inherit', fontSize: '14px', lineHeight: '22px',
			};
			// 浮层卡片：完全复刻 Menu.module.css .list（向上开：bottom 4px gap）。
			var menuStyle = {
				position: 'absolute',
				bottom: 'calc(100% + 4px)',
				left: wide ? 0 : '50%',
				transform: wide ? undefined : 'translateX(-50%)',
				boxSizing: 'border-box',
				padding: '4px',
				display: 'flex', flexDirection: 'column',
				border: '1px solid var(--dsw-alias-border-inverted)',
				borderRadius: '12px',
				background: 'var(--dsw-specific-menu)',
				boxShadow: 'var(--dsw-shadow-lv3)',
				minWidth: '218px', maxWidth: '360px',
				maxHeight: 'calc(100vh - 24px)', overflowY: 'auto',
				zIndex: 100,
			};
			// 头部：复刻 Menu.module.css .label。
			var headerStyle = {
				padding: '8px 10px', fontSize: '12px', lineHeight: '16px',
				color: 'var(--dsw-alias-label-tertiary)',
				overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
			};
			// 菜单项：复刻 Menu.module.css .item（单行 icon + label）。
			var itemStyle = {
				display: 'flex', alignItems: 'center', gap: '8px',
				width: '100%', minHeight: '40px',
				padding: '8px 10px',
				border: 'none', borderRadius: '10px',
				background: 'transparent', cursor: 'pointer',
				fontSize: '14px', lineHeight: '22px',
				color: 'var(--dsw-alias-label-primary)', textAlign: 'left',
			};
			// 图标槽：复刻 .itemIcon。
			var itemIconStyle = {
				display: 'inline-flex', flex: 'none',
				width: '16px', height: '16px',
				alignItems: 'center', justifyContent: 'center',
				color: 'var(--dsw-alias-label-tertiary)',
			};
			// label 槽：复刻 .itemLabel。
			var itemLabelStyle = {
				flex: '1', minWidth: '0',
				overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
			};

			return createElement('span', { style: { position: 'relative', display: 'inline-flex' }, ref: anchorRef },
				createElement('button', {
					type: 'button',
					onClick: onToggle,
					onMouseEnter: function() { setHovered(true); },
					onMouseLeave: function() { setHovered(false); },
					'aria-label': T.newTabLabel, title: T.newTabLabel,
					'aria-haspopup': 'menu', 'aria-expanded': isOpen || undefined,
					style: baseStyle,
				}, createElement(NewChatIcon, {}),
					wide ? createElement('span', { style: { overflow: 'hidden', whiteSpace: 'nowrap' } }, T.newTab) : null),
				isOpen ? createElement('div', {
					role: 'menu', style: menuStyle,
				},
					createElement('div', { style: headerStyle, role: 'presentation' }, T.workspacePick),
					choices.map(function(c) {
						return createElement('button', {
							type: 'button', role: 'menuitem', key: c.id,
							onClick: function() { onPick(c.id); },
							style: itemStyle,
						},
							createElement('span', { style: itemIconStyle },
								createElement(FolderIcon, {})),
							createElement('span', { style: itemLabelStyle, title: c.path }, c.title));
					}),
				) : null,
			);
		}

		module.exports = {
			name: '@mydsh/ui-session-tabs',
			inject: ['slots', 'sessions', 'workspaces'],
			apply(ctx) {
				var sessions = ctx.get('sessions');
				var workspaces = ctx.get('workspaces');
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
				//    点击弹出 workspace 选择框：选一个 workspace 后 connectWorkspace(id)
				//    拿会话 id，再在新标签页深链打开。无 workspace 时退化为打开空标签页。
				ctx.effect(
					() => slots.inject('sidebar.footer.action', (ownerProps) => slots.register({
						name: 'sidebar.footer.action',
						id: 'mydsh-new-tab',
						order: 0,
					}, () => NewTabButton({ wide: ownerProps && ownerProps.wide, workspaces }))),
					'@mydsh/ui-session-tabs: new-tab footer action',
				);
			},
			// 供 tests 直接驱动的纯逻辑（不参与运行时）。
			__test: { deepLink, blankTabUrl, workspaceChoices, openNewTabInWorkspace },
		};
		return module.exports;
	}
});