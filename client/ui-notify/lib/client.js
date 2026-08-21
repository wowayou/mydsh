// mydsh ui-notify — browser-side task completion notification (Notification API + sound).
//
// Registrations:
// 1. conversation.input.dock#mydsh-notify — null component; watches ALL sessions
//    through the sessions list store (sessions.list) instead of only the current
//    session, so a background task in this tab also pings.
// 2. settings.general.item#mydsh-notify-sound — custom sound panel.
//
// Multi-task identification (why this exists):
// - Notification carries the session's displayTitle (title → cwd basename → id).
// - A hidden tab flashes its document.title to "[✓] <task>" so the user can see
//   WHICH TAB finished without switching to it.
// - Each notification has its own tag (per session), so concurrent completions
//   do not replace each other; clicking it focuses the tab and opens the session.
// - Cross-tab dedupe: multiple tabs share the same session list, so a completion
//   would otherwise sound in every open tab. A localStorage claim (30s window)
//   makes exactly one tab notify per edge; the tab where the session is CURRENT
//   always wins (it is the task's owner).
//
// Hand-written __ModuleLoader__ bundle (zero build deps): only requires react.
window.__ModuleLoader__.load({
	id: '@mydsh/ui-notify',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require('react');
		const { useEffect, useRef, useState, useCallback, createElement } = React;

		var SOUND_KEY = 'mydsh.notify.sound';
		/** 静音开关（localStorage）：为 '1' 时完成/打断都不发声，通知照发。 */
		var MUTE_KEY = 'mydsh.notify.mute';
		/**
		 * 自定义提示音的体积上限（原始文件字节数）。
		 * 为什么必须有上限：音频以 base64 data URL 存进 localStorage，而 localStorage 配额
		 * 是**整个 origin 共享**的 —— dsh UI 自己的设置、草稿、其他插件都在同一份配额里。
		 * 一个几 MB 的音频足以把配额吃满，让宿主 UI 的写入开始失败；那是本插件对别人的
		 * 副作用，不是本插件自己的问题。提示音只需要一两秒，512 KiB 绰绰有余。
		 */
		var MAX_SOUND_BYTES = 512 * 1024;
		/** Cross-tab claim window: within this many ms a fresh claim suppresses other tabs. */
		var CLAIM_WINDOW_MS = 30000;
		/** How long a hidden tab keeps the "[✓] <task>" title flash. */
		var FLASH_MS = 15000;

		function isZh() {
			try { return (navigator.language || '').toLowerCase().startsWith('zh'); } catch { return false; }
		}
		var T = isZh()
			? { title: '任务完成', body: '会话已完成', donePrefix: '✅',
			    flashPrefix: '[✓]',
			    pendingTitle: '需要确认', pendingPrefix: '⚠️',
			    pendingApproval: '等待审批', pendingPlan: '计划待审', pendingQuestion: '等待回答',
			    soundLabel: '完成提示音', test: '试听',
			    custom: '自定义音频', default: '默认提示音',
			    upload: '选择文件', remove: '恢复默认',
			    mute: '静音', unmute: '取消静音', mutedNote: '已静音（只弹通知，不发声）',
			    tooBig: '文件过大：上限 512 KB', quotaFull: '保存失败：浏览器存储空间已满',
			    readFailed: '保存失败：无法读取该音频文件' }
			: { title: 'Task done', body: 'The session has finished', donePrefix: '✅',
			    flashPrefix: '[✓]',
			    pendingTitle: 'Needs your input', pendingPrefix: '⚠️',
			    pendingApproval: 'Waiting for approval', pendingPlan: 'Plan awaiting review', pendingQuestion: 'Waiting for answer',
			    soundLabel: 'Notification sound', test: 'Test',
			    custom: 'Custom audio', default: 'Default beep',
			    upload: 'Choose file', remove: 'Reset',
			    mute: 'Mute', unmute: 'Unmute', mutedNote: 'Muted (notification only, no sound)',
			    tooBig: 'File too large: 512 KB max', quotaFull: 'Save failed: browser storage is full',
			    readFailed: 'Save failed: could not read that audio file' };

		// ── 纯逻辑（可在 smoke 测试里直接驱动） ──────────────────────────────

		/** "session-<uuid>" → 前 8 位短号，用于正文与日志消歧。 */
		function shortIdOf(id) {
			var s = String(id == null ? '' : id);
			var base = s.indexOf('session-') === 0 ? s.slice(8) : s;
			return base.length > 8 ? base.slice(0, 8) : base;
		}

		/** 人类可读标签：displayTitle（标题 → cwd 目录名 → 短 id）。 */
		function displayLabelOf(entry, id) {
			var t = entry && (typeof entry.displayTitle === 'string' ? entry.displayTitle : entry.title);
			return (typeof t === 'string' && t !== '') ? t : shortIdOf(id);
		}

		/**
		 * 跨标签页去重认领：同一 completion 边沿只让一个标签页通知。
		 * 30 秒内有新鲜认领 → 返回 false（本页跳过）；否则写入认领并返回 true。
		 * storage 无 localStorage 时永远放行（单页退化）。
		 */
		function claimEdge(id, now, storage) {
			try {
				var key = 'mydsh.notify.edge:' + id;
				var prev = storage.getItem(key);
				if (prev !== null && now - Number(prev) < CLAIM_WINDOW_MS) return false;
				storage.setItem(key, String(now));
				return true;
			} catch {
				return true;
			}
		}

		/**
		 * 边沿扫描器：对 byId 快照做 running→idle / idle→running 边沿检测，
		 * 以及 pendingInteraction 从无→有（打断出现）/ 有→无（打断解除）的边沿检测。
		 * 首次观测只记基线（不触发）；onState(id, entry, kind) 仅在边沿调用：
		 *   kind = 'idle' | 'running' | 'pending' | 'pending-cleared'。
		 * pending 覆盖 approval / plan-review / question 三类打断（store 投影里已分类）。
		 */
		function makeScanner(onState) {
			var prev = {};
			return {
				observe(byId) {
					// 清理已消失的会话条目，避免 prev 无限增长（会话删除/切换后残留）。
					for (var oldId in prev) {
						if (!(oldId in byId)) delete prev[oldId];
					}
					for (var id in byId) {
						var entry = byId[id];
						if (!entry || typeof entry !== 'object') continue;
						var running = !!entry.running;
						var pending = entry.pendingInteraction || null;
						var was = prev[id];
						if (was === undefined) { prev[id] = { running: running, pending: pending }; continue; }
						// running 边沿
						if (was.running === true && running === false) { try { onState(id, entry, 'idle'); } catch {} }
						else if (was.running === false && running === true) { try { onState(id, entry, 'running'); } catch {} }
						// pending 边沿：无→有（打断出现）/ 有→无（打断解除）
						if (was.pending === null && pending !== null) { try { onState(id, entry, 'pending'); } catch {} }
						else if (was.pending !== null && pending === null) { try { onState(id, entry, 'pending-cleared'); } catch {} }
						prev[id] = { running: running, pending: pending };
					}
				},
			};
		}

		// ── 声音（保持不变） ───────────────────────────────────────────────

		function loadCustomSound() {
			try { return localStorage.getItem(SOUND_KEY); } catch { return null; }
		}
		/** 静音状态。读不到（隐私模式等）按「不静音」处理，保持既有行为。 */
		function isMuted() {
			try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
		}
		function setMuted(on) {
			try { if (on) localStorage.setItem(MUTE_KEY, '1'); else localStorage.removeItem(MUTE_KEY); } catch {}
		}
		/**
		 * 存自定义提示音，两道闸：
		 *   1. 读之前先按 file.size 拒超限文件（大文件根本不读进内存）；
		 *   2. setItem 抛 QuotaExceededError 时清掉半截值并 reject —— 调用方必须显示出来，
		 *      不能吞掉：origin 配额是和宿主 UI 共享的，静默失败会让用户以为设置生效了。
		 * reject 的 Error.code ∈ {'too-big','quota','read-failed'}，供 UI 分文案。
		 */
		function saveCustomSound(file) {
			return new Promise(function(resolve, reject) {
				var size = file && typeof file.size === 'number' ? file.size : 0;
				if (size > MAX_SOUND_BYTES) {
					var big = new Error('custom sound too large: ' + size + ' > ' + MAX_SOUND_BYTES);
					big.code = 'too-big';
					reject(big);
					return;
				}
				var reader = new FileReader();
				reader.onload = function() {
					try {
						localStorage.setItem(SOUND_KEY, reader.result);
						resolve();
					} catch (e) {
						try { localStorage.removeItem(SOUND_KEY); } catch {}
						var quota = new Error('localStorage rejected the custom sound (quota)');
						quota.code = 'quota';
						reject(quota);
					}
				};
				reader.onerror = function() {
					var bad = new Error('could not read the audio file');
					bad.code = 'read-failed';
					reject(bad);
				};
				reader.readAsDataURL(file);
			});
		}
		function clearCustomSound() {
			try { localStorage.removeItem(SOUND_KEY); } catch {}
		}

		function beep() {
			try {
				var Ctx = window.AudioContext || window.webkitAudioContext;
				if (!Ctx) return;
				var ac = new Ctx();
				var osc = ac.createOscillator();
				var gain = ac.createGain();
				osc.connect(gain); gain.connect(ac.destination);
				osc.type = 'sine'; osc.frequency.value = 880;
				gain.gain.setValueAtTime(0.1, ac.currentTime);
				gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.4);
				osc.start(); osc.stop(ac.currentTime + 0.45);
				osc.onended = function() { try { ac.close(); } catch {} };
			} catch {}
		}

		/** 播放提示音。force=true 表示用户点了「试听」，静音状态下也响。 */
		function playSound(force) {
			if (!force && isMuted()) return;
			var custom = loadCustomSound();
			if (custom) {
				try { var audio = new Audio(custom); audio.volume = 0.8; audio.play().catch(function() { beep(); }); return; }
				catch {}
			}
			beep();
		}

		// ── 标签页标题闪烁（后台标签可辨识） ───────────────────────────────

		var flash = { original: null, timer: null };

		function flashTab(label) {
			try {
				var doc = document;
				if (flash.original === null) flash.original = doc.title;
				doc.title = T.flashPrefix + ' ' + label;
				if (flash.timer !== null) clearTimeout(flash.timer);
				flash.timer = setTimeout(restoreTitle, FLASH_MS);
			} catch {}
		}

		function restoreTitle() {
			try {
				if (flash.original === null) return;
				if (flash.timer !== null) { clearTimeout(flash.timer); flash.timer = null; }
				if (document.title !== flash.original) document.title = flash.original;
				flash.original = null;
			} catch {}
		}

		// ── 通知 ───────────────────────────────────────────────────────────

		/**
		 * 发一条完成通知。title = "<✅> <任务名>"，body 附短 id；
		 * 每条通知独立 tag（并发完成互不覆盖）；点击 → 聚焦本标签页并打开该会话。
		 */
		function notify(id, label, sessions) {
			playSound();
			try {
				if (typeof window === 'undefined' || !('Notification' in window)) return;
				var body = T.body + ' · ' + shortIdOf(id);
				var show = function() {
					try {
						var n = new Notification(T.donePrefix + ' ' + label, { body: body, tag: 'mydsh-done-' + id });
						n.onclick = function() {
							try { window.focus(); } catch {}
							try { if (sessions && typeof sessions.open === 'function') sessions.open(id); } catch {}
						};
					} catch {}
				};
				if (Notification.permission === 'granted') show();
				else if (Notification.permission !== 'denied') {
					Notification.requestPermission().then(function(p) { if (p === 'granted') show(); });
				}
			} catch {}
		}

		/** 完成边沿处理：去重 + 认领（非当前会话）+ 通知 + 后台标签闪烁。 */
		var notified = new Set();

		function onCompleted(id, entry, isCurrent, sessions) {
			// 本页去重（subscribe 与 poll 双路径 + 组件重挂载）
			if (notified.has(id)) return;
			notified.add(id);
			var label = displayLabelOf(entry, id);
			var doNotify = function() {
				notify(id, label, sessions);
				try { if (document.hidden) flashTab(label); } catch {}
			};
			// 属主（本标签当前会话）无条件通知，并先写认领，让其他标签看到新鲜认领后静默。
			if (isCurrent) {
				try { claimEdge(id, Date.now(), (typeof localStorage !== 'undefined' ? localStorage : null)); } catch {}
				doNotify();
				return;
			}
			// 非属主：跨标签恰好一次。优先 Web Locks（互斥），回退 localStorage 认领。
			var storage = (typeof localStorage !== 'undefined' ? localStorage : null);
			try {
				if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
					navigator.locks.request('mydsh.notify.' + id, { ifAvailable: true }, function(lock) {
						if (!lock) return; // 其他标签正在通知
						if (!claimEdge(id, Date.now(), storage)) return; // 已被认领
						doNotify();
					});
					return;
				}
			} catch {}
			if (claimEdge(id, Date.now(), storage)) doNotify();
		}

		/** 打断边沿处理（approval / plan-review / question 三类）。
		 *  与 completed 独立去重：同一打断只通知一次，pending-cleared 时清理。
		 *  打断比完成更紧急（需要用户介入），属主标签无条件通知 + 跨标签去重。 */
		var notifiedPending = new Set();

		/** pendingInteraction 分类 → 本地化文案。 */
		function pendingLabelOf(kind) {
			if (kind === 'approval') return T.pendingApproval;
			if (kind === 'plan-review') return T.pendingPlan;
			if (kind === 'question') return T.pendingQuestion;
			return T.pendingTitle;
		}

		/** 打断出现：发通知（标题 ⚠️ + 分类 + 会话名）+ 后台标签闪烁。
		 *  跨标签去重用独立的 claim key（与 completed 的 key 分开，互不干扰）。 */
		function onPending(id, entry, kind, isCurrent, sessions) {
			if (notifiedPending.has(id)) return;
			notifiedPending.add(id);
			var label = displayLabelOf(entry, id);
			var pendingText = pendingLabelOf(kind);
			var doNotify = function() {
				playSound();
				try {
					if (typeof window === 'undefined' || !('Notification' in window)) return;
					var body = pendingText + ' · ' + shortIdOf(id);
					var show = function() {
						try {
							var n = new Notification(T.pendingPrefix + ' ' + label, { body: body, tag: 'mydsh-pending-' + id });
							n.onclick = function() {
								try { window.focus(); } catch {}
								try { if (sessions && typeof sessions.open === 'function') sessions.open(id); } catch {}
							};
						} catch {}
					};
					if (Notification.permission === 'granted') show();
					else if (Notification.permission !== 'denied') {
						Notification.requestPermission().then(function(p) { if (p === 'granted') show(); });
					}
				} catch {}
				try { if (document.hidden) flashTab(label); } catch {}
			};
			// 打断更紧急：属主无条件通知，并先写认领。
			var claimKey = 'mydsh.notify.pending:' + id;
			if (isCurrent) {
				try { claimEdge(claimKey, Date.now(), (typeof localStorage !== 'undefined' ? localStorage : null)); } catch {}
				doNotify();
				return;
			}
			// 非属主：跨标签恰好一次。
			var storage = (typeof localStorage !== 'undefined' ? localStorage : null);
			try {
				if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
					navigator.locks.request('mydsh.notify.pending.' + id, { ifAvailable: true }, function(lock) {
						if (!lock) return;
						if (!claimEdge(claimKey, Date.now(), storage)) return;
						doNotify();
					});
					return;
				}
			} catch {}
			if (claimEdge(claimKey, Date.now(), storage)) doNotify();
		}

		/** 打断解除：清理本页去重 + 恢复标签标题（让闪烁停）。 */
		function onPendingCleared(id) {
			try { notifiedPending.delete(id); } catch {}
			try { if (document.hidden) restoreTitle(); } catch {}
		}

		// --- 监听组件（null，无视觉） ---
		// 读 sessions.list store（getSnapshot/subscribe），不依赖 React 渲染调度，
		// 后台标签页也能即时触发（设计教训：不要依赖 React 渲染做后台操作）。
		function NotifyWatcher(props) {
			var sessions = props.sessions;
			var scanner = useRef(null);
			var scan = useRef(null);
			if (scanner.current === null) {
				scanner.current = makeScanner(function(id, entry, kind) {
					if (kind === 'running') { try { notified.delete(id); } catch {} return; }
					if (kind === 'pending') {
						var snap2 = null;
						try { if (sessions && sessions.list) snap2 = sessions.list.getSnapshot(); } catch {}
						var isCur2 = snap2 ? snap2.current === id : false;
						var kind2 = entry && entry.pendingInteraction ? entry.pendingInteraction : 'question';
						onPending(id, entry, kind2, isCur2, sessions);
						return;
					}
					if (kind === 'pending-cleared') {
						onPendingCleared(id);
						return;
					}
					var snap = null;
					try { if (sessions && sessions.list) snap = sessions.list.getSnapshot(); } catch {}
					var isCurrent = snap ? snap.current === id : false;
					onCompleted(id, entry, isCurrent, sessions);
				});
				scan.current = function() {
					try {
						if (!sessions || !sessions.list) return;
						var snap = sessions.list.getSnapshot();
						scanner.current.observe((snap && snap.byId) || {});
					} catch {}
				};
			}

			// 1) store 变更订阅（前台即时）
			useEffect(function() {
				if (!sessions || !sessions.list) return;
				var unsub = null;
				try { unsub = sessions.list.subscribe(scan.current); } catch {}
				return function() { try { if (unsub) unsub(); } catch {} };
			}, [sessions]);

			// 2) 轮询兜底（后台标签页；绕过 React 调度）
			useEffect(function() {
				var timer = setInterval(function() { try { if (scan.current) scan.current(); } catch {} }, 500);
				return function() { clearInterval(timer); };
			}, []);

			// 3) 回到本标签页时恢复原始标题
			useEffect(function() {
				var onVis = function() { try { if (!document.hidden) restoreTitle(); } catch {} };
				try { document.addEventListener('visibilitychange', onVis); } catch {}
				return function() { try { document.removeEventListener('visibilitychange', onVis); } catch {} };
			}, []);

			return null;
		}

		// --- Settings row: matches DSH General section row pattern ---
		// Visual language from LanguageRow.tsx / AppearanceRow.tsx:
		//   .row: flex, align-center, gap 8px, padding 16px 0, border-bottom hairline
		//   .title: 14px, weight 400, line-height 22px, color label-primary
		//   .selector: h36, r18, bg-module-platform, pad 0/14, font inherit
		function SoundSettings() {
			var fileRef = useRef(null);
			var state = useState(loadCustomSound());
			var customUrl = state[0]; var setCustomUrl = state[1];
			var hasCustom = customUrl !== null;
			var errState = useState(null);
			var err = errState[0]; var setErr = errState[1];
			var muteState = useState(isMuted());
			var muted = muteState[0]; var setMutedUi = muteState[1];

			var onFile = useCallback(function(e) {
				var file = e.target.files && e.target.files[0];
				if (!file) return;
				setErr(null);
				saveCustomSound(file).then(function() {
					setCustomUrl(loadCustomSound());
					playSound(true);
				}).catch(function(e2) {
					// 失败必须可见：静默 catch 会让用户以为换音成功了，
					// 而 quota 失败还意味着 origin 存储已经紧张（宿主 UI 也会受影响）。
					var code = e2 && e2.code;
					setErr(code === 'too-big' ? T.tooBig : code === 'read-failed' ? T.readFailed : T.quotaFull);
					setCustomUrl(loadCustomSound());
					try { console.warn('[@mydsh/ui-notify] custom sound not saved:', e2 && e2.message); } catch {}
				});
				if (fileRef.current) fileRef.current.value = '';
			}, []);

			var onRemove = useCallback(function() {
				clearCustomSound();
				setCustomUrl(null);
				setErr(null);
			}, []);

			var onTest = useCallback(function() { playSound(true); }, []);

			// 静音开关：不想听声音的人不必卸插件（通知本身还在）。
			var onMute = useCallback(function() {
				var next = !isMuted();
				setMuted(next);
				setMutedUi(next);
			}, []);

			var rowStyle = {
				display: 'flex', alignItems: 'center', gap: '8px', padding: '16px 0',
				borderBottom: '1px solid var(--dsw-alias-border-l2)',
			};
			var textSectionStyle = {
				flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '4px',
				paddingRight: '48px',
			};
			var titleStyle = {
				fontSize: '14px', fontWeight: 400, lineHeight: '22px',
				color: 'var(--dsw-alias-label-primary)',
			};
			var subtitleStyle = {
				fontSize: '12px', lineHeight: '18px',
				color: err !== null
					? 'var(--dsw-alias-state-warn-primary)'
					: hasCustom ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)',
			};
			var subtitleText = err !== null
				? err
				: muted ? T.mutedNote : hasCustom ? T.custom : T.default;
			// 设置行操作按钮：对齐 DSH Button ghost（Button.module.css）——
			//   h36 / r18 / pad 0 14 / gap 4 / 14-22 / transparent + hover interactive-bg-hover。
			var buttonBase = {
				display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
				border: 'none', borderRadius: '18px', cursor: 'pointer',
				fontSize: '14px', lineHeight: '22px',
				color: 'var(--dsw-alias-label-primary)',
				background: 'transparent',
				padding: '0 14px', height: '36px',
				flexShrink: 0,
			};
			// 上传 label 复用 ghost 按钮视觉（hover 高亮）。
			var UploadLabel = function(props) {
				var hoverState = useState(false);
				var hov = hoverState[0]; var setHov = hoverState[1];
				return createElement('label', {
					onMouseEnter: function() { setHov(true); },
					onMouseLeave: function() { setHov(false); },
					style: Object.assign({}, buttonBase, {
						cursor: 'pointer',
						background: hov ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
					}),
				}, props.children,
					createElement('input', {
						ref: fileRef, type: 'file',
						accept: 'audio/*,.mp3,.wav,.ogg,.m4a,.flac,.aac',
						style: { display: 'none' },
						onChange: onFile,
					}),
				);
			};
			var GhostBtn = function(props) {
				var hoverState = useState(false);
				var hov = hoverState[0]; var setHov = hoverState[1];
				return createElement('button', {
					type: 'button', onClick: props.onClick,
					onMouseEnter: function() { setHov(true); },
					onMouseLeave: function() { setHov(false); },
					style: Object.assign({}, buttonBase, {
						background: hov ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
						color: props.danger ? 'var(--dsw-alias-state-warn-primary)' : buttonBase.color,
					}),
				}, props.children);
			};

			return createElement('div', { style: rowStyle },
				createElement('div', { style: textSectionStyle },
					createElement('div', { style: titleStyle }, T.soundLabel),
					createElement('div', { style: subtitleStyle }, subtitleText),
				),
				// Upload button（ghost 视觉，label 包 file input）
				createElement(UploadLabel, {}, T.upload),
				// Test button（ghost）：显式试听，静音时也响
				createElement(GhostBtn, { onClick: onTest }, T.test),
				// Mute toggle（ghost）：静音后只弹通知不发声
				createElement(GhostBtn, { onClick: onMute }, muted ? T.unmute : T.mute),
				// Reset button（ghost，warn 色；仅自定义时有）
				hasCustom ? createElement(GhostBtn, { onClick: onRemove, danger: true }, T.remove) : null,
			);
		}

		// ── 重复挂载防护 ───────────────────────────────────────────────────
		// 两条安装路径都走一遍（仓库 install.sh 往 profile 的 cordis.patch.yml 写行 +
		// npm 包自带的 bundle patch 层），组合后的 loader tree 里就会有两行同 id 的插件行：
		// apply() 跑两次 → 两份监听器 → 一次完成响两声、设置里出现两行。别人安装时最容易
		// 踩这个，所以插件自己兜住：第二份只打一条能照着做的警告然后退出。
		var MOUNT_KEY = '__mydshUiNotifyMounts';

		/** 认领本进程内的唯一挂载权；返回 false 表示自己是重复的那份。 */
		function claimMount(ctx) {
			var g = typeof window !== 'undefined' ? window : globalThis;
			var n = (g[MOUNT_KEY] || 0) + 1;
			g[MOUNT_KEY] = n;
			// 计数跟着插件生命周期回落，HMR / 卸载重挂不会假报重复。
			ctx.effect(function() {
				return function() { g[MOUNT_KEY] = Math.max(0, (g[MOUNT_KEY] || 1) - 1); };
			}, '@mydsh/ui-notify: mount counter');
			if (n > 1) {
				try {
					console.warn(
						'[@mydsh/ui-notify] mounted ' + n + ' times — the plugin row appears more than once in '
						+ 'the composed tree, so this copy registered nothing. Keep ONE install path: either the npm '
						+ 'bundle layer (`dsh plugin --profile web add @mydsh/ui-notify`) or the mydsh repo rows in '
						+ '$DSH_HOME/profiles/web/cordis.patch.yml — not both. Check with `dsh --profile web --dump-config`.',
					);
				} catch {}
				return false;
			}
			return true;
		}

		module.exports = {
			name: '@mydsh/ui-notify',
			inject: ['slots', 'sessions'],
			apply(ctx) {
				var sessions = ctx.get('sessions');
				var slots = ctx.get('slots');
				if (slots === undefined) {
					// 静默 return 会让「装上了但什么都没发生」无从排查（例如宿主重命名了服务）。
					try {
						console.warn(
							'[@mydsh/ui-notify] the host exposes no `slots` service — nothing was registered. '
							+ 'This build targets the dsh web profile (verified against dsh 0.1.0-rc.5).',
						);
					} catch {}
					return;
				}
				if (!claimMount(ctx)) return;
				ctx.effect(
					() => slots.inject('conversation.input.dock', () => slots.register({
						name: 'conversation.input.dock',
						id: 'mydsh-notify',
						order: 100,
					}, (props) => NotifyWatcher({ ...props, sessions }))),
					'@mydsh/ui-notify: dock watcher',
				);
				ctx.effect(
					() => slots.inject('settings.general.item', () => slots.register({
						name: 'settings.general.item',
						id: 'mydsh-notify-sound',
						order: 20,
					}, SoundSettings)),
					'@mydsh/ui-notify: sound settings',
				);
			},
			// 供 tests/smoke.mjs 直接驱动的纯逻辑（不参与运行时）。
			__test: { makeScanner, claimEdge, displayLabelOf, shortIdOf,
			          saveCustomSound, loadCustomSound, clearCustomSound, isMuted, setMuted, playSound,
			          MAX_SOUND_BYTES, SOUND_KEY, MUTE_KEY },
		};
		return module.exports;
	}
});
