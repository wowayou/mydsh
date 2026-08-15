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
	id: '@mydsh/ui-annotate',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require('react');
		const { useState, useEffect, useRef, useCallback, createElement } = React;

		const STORAGE_KEY = 'mydsh.annotations.v1';
		const MAX_NOTE = 2000;
		const MAX_SEL = 500;

		function isZh() {
			try { return (navigator.language || '').toLowerCase().startsWith('zh'); } catch { return false; }
		}
		const T = isZh()
			? { annotate: '批注', add: '添加批注', placeholder: '写下你的批注…', empty: '暂无批注', selected: '选中的文本', noSel: '（未选中文本）', cancel: '取消', del: '删除', saved: '已保存' }
			: { annotate: 'Annotate', add: 'Add note', placeholder: 'Write a note…', empty: 'No annotations', selected: 'Selected text', noSel: '(no text selected)', cancel: 'Cancel', del: 'Delete', saved: 'Saved' };

		function loadAll() {
			try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; }
		}
		function saveAll(all) {
			try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); } catch {}
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
				saveAll(all);
				setNote('');
				refresh();
			}, [note, sel, sessionId, messageId, refresh]);

			const removeNote = useCallback((id) => {
				const all = loadAll();
				const k = bucketKey(sessionId, messageId);
				all[k] = listOf(all, k).filter((x) => x.id !== id);
				saveAll(all);
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

		module.exports = {
			name: '@mydsh/ui-annotate',
			inject: ['slots'],
			apply(ctx) {
				const slots = ctx.get('slots');
				if (slots === undefined) return;
				ctx.effect(
					() => slots.inject('conversation.chat.assistant-actions', () => slots.register({
						name: 'conversation.chat.assistant-actions',
						id: 'mydsh-annotate',
						order: 15,
					}, AnnotateAction)),
					'@mydsh/ui-annotate: assistant action',
				);
			},
		};
		return module.exports;
	}
});
