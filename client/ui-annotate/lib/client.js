// mydsh ui-annotate — 浏览器半边：Codex 式「选中回复加批注」。
//
// 手写 __ModuleLoader__ bundle（零构建依赖）：只 require 平台模块表里的 react。
// 机制：
//   - 在 `conversation.chat.assistant-actions`（每条已定稿助手消息的操作条）注册
//     一个「批注」按钮（带数量角标）。
//   - 点击按钮时（mousedown 阶段，选区尚未被清掉）捕获页面上选中的文本作为摘录，
//     打开弹层：列出本条消息已有批注，可新增/删除。
//   - 数据存 localStorage（key = mydsh.annotations.v1，按 sessionId:messageId 分桶），
//     不依赖任何后端；v2 可升级为 host 存储 + 模型可见。
window.__ModuleLoader__.load({
	id: '@wowayou/ui-annotate',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require('react');
		const { useState, useEffect, useRef, useCallback, createElement } = React;

		const STORAGE_KEY = 'mydsh.annotations.v1';
		const MAX_NOTE = 2000;
		const MAX_SEL = 500;
		/**
		 * 整个批注库的体积上限。localStorage 配额是**整个 origin 共享**的 —— dsh UI
		 * 自己的设置、草稿、其他插件都在同一份配额里，批注无限增长会把配额吃满，
		 * 让宿主 UI 的写入开始失败。到顶就拒绝新增（旧批注一条不动），并把原因说出来。
		 */
		const MAX_TOTAL_BYTES = 256 * 1024;

		function isZh() {
			try { return (navigator.language || '').toLowerCase().startsWith('zh'); } catch { return false; }
		}
		const T = isZh()
			? { annotate: '批注', add: '添加批注', placeholder: '写下你的批注…', empty: '暂无批注', selected: '选中的文本', noSel: '（未选中文本）', cancel: '取消', del: '删除', saved: '已保存',
			    full: '批注库已满（上限 256 KB），请先删除一些批注' }
			: { annotate: 'Annotate', add: 'Add note', placeholder: 'Write a note…', empty: 'No annotations', selected: 'Selected text', noSel: '(no text selected)', cancel: 'Cancel', del: 'Delete', saved: 'Saved',
			    full: 'Annotation store is full (256 KB max) — delete some notes first' };

		function loadAll() {
			try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
		}
		/**
		 * 写回批注库。两道闸：总体积上限 + setItem 失败要报出来（不能吞）。
		 * @param shrinking - 这次写是删除（结果只会变小）。删除必须永远放行，否则
		 *   一个已经超限的旧库（升级前存下的）会把用户锁在「删不掉也存不下」里。
		 * @returns 'ok' | 'too-big' | 'quota' —— 调用方负责把非 ok 显示给用户。
		 */
		function saveAll(all, shrinking) {
			var json;
			try { json = JSON.stringify(all); } catch { return 'quota'; }
			if (!shrinking && json.length > MAX_TOTAL_BYTES) return 'too-big';
			try {
				localStorage.setItem(STORAGE_KEY, json);
				return 'ok';
			} catch {
				try { console.warn('[@wowayou/ui-annotate] localStorage rejected the write (origin quota is shared with the dsh UI)'); } catch {}
				return 'quota';
			}
		}
		function bucketKey(sessionId, messageId) { return String(sessionId) + ':' + String(messageId); }
		function listOf(all, k) { return Array.isArray(all[k]) ? all[k] : []; }

		const popStyle = {
			position: 'fixed',
			zIndex: 9999,
			width: 'min(360px, 90vw)',
			maxHeight: '60vh',
			overflowY: 'auto',
			background: 'var(--dsw-alias-bg-overlay, #20242e)',
			border: '1px solid var(--dsw-alias-border-l2, #3a4152)',
			borderRadius: '10px',
			boxShadow: '0 8px 28px rgba(0,0,0,.35)',
			padding: '10px 12px',
			fontSize: '13px',
			lineHeight: 1.5,
			color: 'var(--dsw-alias-label-primary, #e6e9ef)',
		};

		function AnnotateAction(props) {
			const messageId = props.messageId;
			const sessionId = props.sessionId;
			const [open, setOpen] = useState(false);
			const [pos, setPos] = useState(null);
			const [note, setNote] = useState('');
			const [sel, setSel] = useState('');
			const [items, setItems] = useState([]);
			const [err, setErr] = useState(null);
			const btnRef = useRef(null);

			const refresh = useCallback(() => {
				setItems(listOf(loadAll(), bucketKey(sessionId, messageId)));
			}, [sessionId, messageId]);

			useEffect(() => { refresh(); }, [refresh, open]);

			// 点击按钮（mousedown 阶段）：先把页面上的选区抓下来当摘录，再翻转弹层。
			const onMouseDown = useCallback((e) => {
				try {
					const s = window.getSelection();
					const text = s && s.toString ? s.toString().trim() : '';
					setSel(text.length > MAX_SEL ? text.slice(0, MAX_SEL) : text);
				} catch { setSel(''); }
				const rect = e.currentTarget ? e.currentTarget.getBoundingClientRect() : null;
				if (rect) {
					let top = rect.bottom + 8;
					let left = Math.max(8, Math.min(rect.left, window.innerWidth - 380));
					if (top + 320 > window.innerHeight) top = Math.max(8, rect.top - 320);
					setPos({ top, left });
				}
				setOpen((o) => !o);
			}, []);

			const addNote = useCallback(() => {
				const text = note.trim();
				if (text === '') return;
				const all = loadAll();
				const k = bucketKey(sessionId, messageId);
				const items = listOf(all, k);
				items.push({
					id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
					t: new Date().toISOString(),
					note: text.length > MAX_NOTE ? text.slice(0, MAX_NOTE) : text,
					sel: sel || undefined,
				});
				all[k] = items;
				// 写不进去就别假装成功：保留输入框内容，让用户看到原因（删几条再存）。
				if (saveAll(all) !== 'ok') { setErr(T.full); return; }
				setErr(null);
				setNote('');
				refresh();
			}, [note, sel, sessionId, messageId, refresh]);

			const removeNote = useCallback((id) => {
				const all = loadAll();
				const k = bucketKey(sessionId, messageId);
				all[k] = listOf(all, k).filter((x) => x.id !== id);
				if (saveAll(all, true) === 'ok') setErr(null);
				refresh();
			}, [sessionId, messageId, refresh]);

			const btnStyle = {
				display: 'inline-flex', alignItems: 'center', gap: '4px',
				background: 'transparent', border: 'none', cursor: 'pointer',
				color: 'var(--dsw-alias-label-secondary, #9aa3b2)',
				fontSize: '12px', padding: '2px 6px', borderRadius: '6px',
			};

			return createElement(React.Fragment, null,
				createElement('button', {
					ref: btnRef,
					title: T.annotate,
					onMouseDown: onMouseDown,
					style: btnStyle,
				},
					createElement('span', null, '✎ ' + T.annotate),
					items.length > 0
						? createElement('span', { style: { color: 'var(--dsw-alias-brand-primary, #4d8dff)' } }, String(items.length))
						: null,
				),
				open && pos
					? createElement('div', { style: { ...popStyle, top: pos.top, left: pos.left } },
						createElement('div', { style: { fontWeight: 600, marginBottom: 6 } }, T.annotate + ' · ' + String(messageId).slice(0, 8)),
						createElement('div', { style: { marginBottom: 8, fontSize: '12px' } },
							createElement('div', { style: { color: 'var(--dsw-alias-label-secondary, #9aa3b2)' } }, T.selected),
							createElement('div', {
								style: {
									background: 'var(--dsw-alias-bg-layer-2, #171a21)',
									borderRadius: 6, padding: '4px 8px', marginTop: 2,
									whiteSpace: 'pre-wrap', wordBreak: 'break-word',
									fontStyle: sel ? 'normal' : 'italic', color: 'var(--dsw-alias-label-secondary, #9aa3b2)',
								},
							}, sel || T.noSel),
						),
						createElement('textarea', {
							value: note,
							placeholder: T.placeholder,
							onChange: (e) => setNote(e.target.value),
							rows: 3,
							style: {
								width: '100%', boxSizing: 'border-box',
								background: 'var(--dsw-alias-bg-layer-2, #171a21)',
								color: 'var(--dsw-alias-label-primary, #e6e9ef)',
								border: '1px solid var(--dsw-alias-border-l1, #2c313d)',
								borderRadius: 6, padding: '6px 8px', resize: 'vertical',
								font: 'inherit',
							},
						}),
						createElement('div', { style: { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' } },
							createElement('button', {
								onClick: addNote,
								disabled: note.trim() === '',
								style: {
									background: 'var(--dsw-alias-brand-primary, #4d8dff)',
									color: '#fff', border: 'none', borderRadius: 6,
									padding: '4px 12px', cursor: note.trim() === '' ? 'not-allowed' : 'pointer',
									opacity: note.trim() === '' ? 0.6 : 1,
								},
							}, T.add),
							createElement('button', {
								onClick: () => setOpen(false),
								style: { background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--dsw-alias-label-secondary, #9aa3b2)' },
							}, T.cancel),
						),
						createElement('div', { style: { marginTop: 10, borderTop: '1px solid var(--dsw-alias-border-l1, #2c313d)', paddingTop: 8 } },
							err !== null
								? createElement('div', { style: { color: 'var(--dsw-alias-state-warn-primary, #e5a24a)', marginBottom: '6px' } }, err)
								: null,
							items.length === 0
								? createElement('div', { style: { color: 'var(--dsw-alias-label-secondary, #9aa3b2)', fontStyle: 'italic' } }, T.empty)
								: items.map((it) => createElement('div', { key: it.id, style: { marginBottom: 8 } },
									createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
										createElement('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #9aa3b2)' } }, new Date(it.t).toLocaleString()),
										createElement('button', {
											onClick: () => removeNote(it.id),
											title: T.del,
											style: { background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--dsw-alias-state-warn-primary, #e0a03c)', fontSize: '12px' },
										}, '✕'),
									),
									it.sel
										? createElement('div', {
											style: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary, #3fae6a)', fontStyle: 'italic', marginTop: 2, wordBreak: 'break-word' },
										}, '“' + it.sel + '”')
										: null,
									createElement('div', { style: { marginTop: 2, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, it.note),
								)),
						),
					)
					: null,
			);
		}

		// ── 重复挂载防护 ───────────────────────────────────────────────────
		// 两条安装路径都走一遍（仓库的 profile patch 行 + npm 包自带的 bundle patch 层），
		// 组合后的 loader tree 里就会有两行同 id 的插件行 → 每条消息两个「批注」按钮。
		const MOUNT_KEY = '__mydshUiAnnotateMounts';

		/** 认领本进程内的唯一挂载权；返回 false 表示自己是重复的那份。 */
		function claimMount(ctx) {
			const g = typeof window !== 'undefined' ? window : globalThis;
			const n = (g[MOUNT_KEY] || 0) + 1;
			g[MOUNT_KEY] = n;
			ctx.effect(() => () => { g[MOUNT_KEY] = Math.max(0, (g[MOUNT_KEY] || 1) - 1); },
				'@wowayou/ui-annotate: mount counter');
			if (n > 1) {
				try {
					console.warn(
						'[@wowayou/ui-annotate] mounted ' + n + ' times — the plugin row appears more than once in '
						+ 'the composed tree, so this copy registered nothing. Keep ONE install path and check with '
						+ '`dsh --profile web --dump-config`.',
					);
				} catch {}
				return false;
			}
			return true;
		}

		module.exports = {
			name: '@wowayou/ui-annotate',
			inject: ['slots'],
			apply(ctx) {
				const slots = ctx.get('slots');
				if (slots === undefined) {
					try {
						console.warn(
							'[@wowayou/ui-annotate] the host exposes no `slots` service — nothing was registered. '
							+ 'This build targets the dsh web profile (verified against dsh 0.1.0-rc.5).',
						);
					} catch {}
					return;
				}
				if (!claimMount(ctx)) return;
				ctx.effect(
					() => slots.inject('conversation.chat.assistant-actions', () => slots.register({
						name: 'conversation.chat.assistant-actions',
						id: 'mydsh-annotate',
						order: 15,
					}, AnnotateAction)),
					'@wowayou/ui-annotate: assistant action',
				);
			},
			// 供 tests 直接驱动的纯逻辑（不参与运行时）。
			__test: { saveAll, loadAll, bucketKey, MAX_TOTAL_BYTES },
		};
		return module.exports;
	}
});
