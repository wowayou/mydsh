// mydsh ui-video — 浏览器半边：把消息里引用的本地视频/音频渲染成播放器。
//
// 手写 __ModuleLoader__ bundle（零构建依赖，纯 DOM，不需要 react）。
// 机制：
//   - 在会话内容区挂 MutationObserver：发现指向本地媒体文件的 <a> 链接
//     （href 以 .mp4/.webm/.mov/.m4v/.mkv/.mp3/.wav/.ogg/.flac/.m4a 结尾，
//     且不是 http(s) 外链），就把它替换成 <video controls>（音频则 <audio>），
//     src 指向主机层路由 `/mydsh-media/<encodeURIComponent(绝对路径)>`。
//   - 约定：模型/用户在消息里用绝对路径写媒体链接，例如
//     `[demo.mp4](/home/user/videos/demo.mp4)` 或直接 `[demo.mp4](/home/... )`。
//   - 幂等：已处理过的元素打上标记，不重复替换；新消息到达时自动生效。
window.__ModuleLoader__.load({
	id: '@wowayou/ui-video',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const MEDIA_RE = /\.(mp4|webm|mov|m4v|mkv|ogv|mp3|wav|ogg|flac|m4a)(\?.*)?$/i;
		const AUDIO_RE = /\.(mp3|wav|ogg|flac|m4a)(\?.*)?$/i;
		const PROCESSED = 'data-mydsh-media';
		let started = false;

		function isZh() {
			try { return (navigator.language || '').toLowerCase().startsWith('zh'); } catch { return false; }
		}
		const HINT = isZh()
			? '（播放不了：需要 mydsh 主机层的 /mydsh-media 路由，见 @wowayou/ui-video 的 README）'
			: '(cannot play: needs mydsh\u2019s host-side /mydsh-media route \u2014 see the @wowayou/ui-video README)';

		/**
		 * 只升级「单个前导斜杠的绝对路径」—— 正好是主机层路由能接受的形状
		 * （host/media.ts 要求解码后 startsWith('/')）。于是协议相对地址（//host/x.mp4）、
		 * http(s)/data/blob/javascript URL、相对路径都不会被改写成媒体请求。
		 */
		function isLocalAbsolute(href) {
			try { return href.charAt(0) === '/' && href.charAt(1) !== '/'; } catch { return false; }
		}

		/**
		 * 播放器 + 兜底原链接。
		 * 为什么不直接把 <a> replaceChild 掉：只从 npm 装本包时，主机层的 /mydsh-media
		 * 路由并不存在（那半边在 mydsh 仓库里，是安全代码，没复制进包），播放器永远加载
		 * 不出来 —— 若原链接已被删掉，用户既看不到视频也点不开文件，还只能在 devtools
		 * 里看到一串 404。改成：原 <a> 留在 DOM 里（先隐藏），播放器 error 时显示回来
		 * 并附一句原因。
		 */
		function playerFor(href, isAudio, anchor) {
			const src = '/mydsh-media/' + encodeURIComponent(href);
			const wrap = document.createElement('div');
			wrap.setAttribute(PROCESSED, '1');
			wrap.style.margin = '6px 0';

			const el = document.createElement(isAudio ? 'audio' : 'video');
			el.controls = true;
			el.preload = 'metadata';
			el.style.maxWidth = '100%';
			el.style.borderRadius = '8px';
			if (!isAudio) el.style.width = 'min(560px, 100%)';
			el.src = src;

			const fallback = document.createElement('div');
			fallback.style.display = 'none';
			fallback.style.fontSize = '12px';
			fallback.style.lineHeight = '18px';
			fallback.style.opacity = '0.75';
			if (anchor) fallback.appendChild(anchor);
			const hint = document.createElement('span');
			hint.textContent = ' ' + HINT;
			fallback.appendChild(hint);

			el.addEventListener('error', function() {
				el.style.display = 'none';
				fallback.style.display = 'block';
			}, { once: true });

			wrap.appendChild(el);
			wrap.appendChild(fallback);
			return wrap;
		}

		/** 扫描并升级一个容器内的媒体链接。 */
		function upgrade(root) {
			const links = root.querySelectorAll ? root.querySelectorAll('a[href]') : [];
			for (const a of links) {
				if (a.getAttribute(PROCESSED) === '1') continue;
				const href = a.getAttribute('href') || '';
				if (!MEDIA_RE.test(href) || !isLocalAbsolute(href)) continue;
				const parent = a.parentNode;
				if (!parent) continue;
				a.setAttribute(PROCESSED, '1');
				// 先记住插入位置：playerFor 会把 a 搬进 fallback（从 parent 摘下来），
				// 之后就不能再用 replaceChild(player, a) 了。
				const next = a.nextSibling;
				const player = playerFor(href, AUDIO_RE.test(href), a);
				parent.insertBefore(player, next);
			}
		}

		/** 当前 MutationObserver（模块闭包内，不往 window 上挂全局名字）。 */
		let observerRef = null;

		function start() {
			if (started) return;
			started = true;
			const boot = () => {
				upgrade(document.body);
				// 增量扫描：只处理 MutationRecord.addedNodes 里的新节点，
				// 不全量 querySelectorAll(body)——长会话下每次 DOM 变化全扫会卡。
				const observer = new MutationObserver((records) => {
					for (const record of records) {
						for (const node of record.addedNodes) {
							if (!node || node.nodeType !== 1) continue;
							upgrade(node);
						}
					}
				});
				observer.observe(document.body, { childList: true, subtree: true });
				observerRef = observer;
			};
			if (document.body) boot();
			else document.addEventListener('DOMContentLoaded', boot, { once: true });
		}

		// ── 重复挂载防护 ───────────────────────────────────────────────────
		// 两条安装路径都走一遍（仓库 install.sh 写 profile 的 cordis.patch.yml + npm 包
		// 自带的 bundle patch 层），组合后的 loader tree 里就会有两行同 id 的插件行，
		// 于是两份 MutationObserver 同时扫 DOM。别人安装时最容易踩这个，插件自己兜住。
		const MOUNT_KEY = '__mydshUiVideoMounts';

		/** 认领本进程内的唯一挂载权；返回 false 表示自己是重复的那份。 */
		function claimMount(ctx) {
			const g = typeof window !== 'undefined' ? window : globalThis;
			const n = (g[MOUNT_KEY] || 0) + 1;
			g[MOUNT_KEY] = n;
			ctx.effect(() => () => { g[MOUNT_KEY] = Math.max(0, (g[MOUNT_KEY] || 1) - 1); },
				'@wowayou/ui-video: mount counter');
			if (n > 1) {
				try {
					console.warn(
						'[@wowayou/ui-video] mounted ' + n + ' times — the plugin row appears more than once in '
						+ 'the composed tree, so this copy started no observer. Keep ONE install path: either the npm '
						+ 'bundle layer (`dsh plugin --profile web add @wowayou/ui-video`) or the mydsh repo rows in '
						+ '$DSH_HOME/profiles/web/cordis.patch.yml — not both. Check with `dsh --profile web --dump-config`.',
					);
				} catch {}
				return false;
			}
			return true;
		}

		module.exports = {
			name: '@wowayou/ui-video',
			apply(ctx) {
				if (!claimMount(ctx)) return;
				// 走 ctx.effect 生命周期：插件卸载时框架自动调用 disposer，
				// 断开 MutationObserver，避免资源泄漏。
				ctx.effect(() => {
					start();
					return () => {
						try { if (observerRef) observerRef.disconnect(); } catch {}
						observerRef = null;
						started = false; // 允许重新挂载
					};
				}, '@wowayou/ui-video: observer');
			},
			// 供 tests 直接驱动的纯逻辑（不参与运行时）。
			__test: { isLocalAbsolute, playerFor, MEDIA_RE, AUDIO_RE },
		};
		return module.exports;
	}
});
