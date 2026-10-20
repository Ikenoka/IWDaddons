// ==UserScript==
// @name        DG radiance
// @namespace   Addons
// @match       https://play.isleward.com/*
// @match       https://ptr.isleward.com/*
// @version     1.2.7
// @author      Kara + Claude <3
// @description DG tier cosmetic changes
// @grant       none
// ==/UserScript==
/*
 * DG Radiant Items — Isleward addon
 *
 * Works alongside the "DG Perf Tiers" addon (the one that sets item.dgTier).
 * For any item whose dgTier.pct is 160% or higher:
 *   - the item's name in its tooltip is shown in radiant yellow
 *   - the item's slot border in the inventory grid glows radiant yellow (the slot's
 *     original rarity background is left untouched)
 *   - a chime plays when the item enters your inventory
 *
 * Load this addon AFTER (or alongside) the DG Perf Tiers addon. It reads
 * item.dgTier lazily, after all other onGetItems handlers have run, so the
 * load order between the two addons doesn't matter.
 */
(function () {
	// ---- Settings -----------------------------------------------------------
	const THRESHOLD = 1.6;            // dgTier.pct is a fraction: 1.6 == 160%. Items at or above this count.
	const COLOR = '#ffe600';          // fallback colour (radiant yellow)
	const GLOW = 'rgba(255, 230, 0, 0.85)';
	// Glow colour is a hard step by tier: an item uses the colour of the highest stop whose
	// pct it has reached (at or above it). [pct, [r, g, b]]
	const COLOR_STOPS = [
		[1.6, [210, 178, 135]],         // 160% up to 239.9%: tan
		[2.4, [249, 150, 25]],          // 240% up to 319.9%: orange
		[3.2, [255, 255, 255]]          // 320% and above: brilliant white
	];
	// At or above EDGE_PCT the slot also gets a thin outer edge in EDGE_RGB.
	const EDGE_PCT = 3.2;
	const EDGE_RGB = [255, 0, 0];
	const SOUND_ENABLED = true;
	const SOUND_VOLUME = 0.375;       // 0..~0.6 (output peaks near 1.0 at 0.66, so keep it below that)
	const BASELINE_GRACE_MS = 2500;   // ignore "new" items while the inventory is first loading

	// ---- Selectors (adjust here if the game's DOM changes) ------------------
	const SEL_INV_ITEMS = '.ui-container .uiInventory .grid .item';
	const SEL_TOOLTIP = '.uiTooltips .tooltip, .uiTooltip';
	// -------------------------------------------------------------------------

	const CSS = `
	${SEL_INV_ITEMS}.dgRadiant,
	.renderItem.item.dgRadiant {
		border: 2px solid var(--dg-c, ${COLOR}) !important;
		box-shadow: 0 0 3.75px 1.75px var(--dg-edge, transparent), 0 0 6.25px calc(2.75px + var(--dg-len, 0px)) var(--dg-glow, ${GLOW}), 0 0 6.25px calc(2.75px + var(--dg-len, 0px)) var(--dg-boost, transparent);
		outline: none;
	}
	.dgRadiantTip {
		border-color: var(--dg-c, ${COLOR}) !important;
		box-shadow: 0 0 3.75px 2.25px var(--dg-edge, transparent), 0 0 6.25px calc(3.75px + var(--dg-len, 0px)) var(--dg-glow, ${GLOW}), 0 0 6.25px calc(3.75px + var(--dg-len, 0px)) var(--dg-boost, transparent) !important;
	}
	.dgRadiantName,
	.dgRadiantTip .heading,
	.dgRadiantTip .name,
	.dgRadiantTip .heading *,
	.dgRadiantTip .name * {
		color: var(--dg-c, ${COLOR}) !important;
		text-shadow: var(--dg-name-shadow, 0 0 6px ${GLOW});
		-webkit-text-stroke: var(--dg-name-stroke, 0 transparent);
		paint-order: stroke fill;
	}
	`;

	let refresh = true;
	const seenIds = new Set();
	const posMap = {};            // inventory slot -> item (fallback when DOM data isn't available)
	let baselineDone = false;
	let baselineTime = 0;
	let audioCtx = null;

	function defer(method) {
		if (window.$ && window.addons) method();
		else setTimeout(() => defer(method), 50);
	}

	function injectCss() {
		if (document.getElementById('dgRadiantStyle')) return;
		const style = document.createElement('style');
		style.id = 'dgRadiantStyle';
		style.textContent = CSS;
		document.head.appendChild(style);
	}

	// pct for an item, from dgTier if present, otherwise parsed from the name label
	function getPct(item) {
		if (!item) return 0;
		if (item.dgTier && Number.isFinite(item.dgTier.pct)) return item.dgTier.pct;
		if (typeof item.name === 'string') {
			const m = item.name.match(/\[(\d+(?:\.\d+)?)%\s*\(x\d\)\]/);
			if (m) return parseFloat(m[1]) / 100;
		}
		return 0;
	}

	function isRadiant(item) {
		// Greater than OR equal to the threshold. The pct is rounded to the same
		// precision shown in the item label (0.1%), so an item displaying
		// "160.0%" counts even if the raw float is a hair under 1.6.
		return Math.round(getPct(item) * 1000) / 1000 >= THRESHOLD;
	}

	// ---- Tier -> colour gradient ---------------------------------------------
	function tierColors(item) {
		// Compare at the label's precision (0.1%), so "240.0%" counts as 240%.
		const pct = Math.round(getPct(item) * 1000) / 1000;
		let rgb = COLOR_STOPS[0][1];
		for (const [p, c] of COLOR_STOPS) {
			if (pct >= p) rgb = c;
		}
		const edge = pct >= EDGE_PCT;
		return {
			c: 'rgb(' + rgb.join(',') + ')',
			glow: 'rgb(' + rgb.join(',') + ')',
			edge: edge ? 'rgb(' + EDGE_RGB.join(',') + ')' : 'transparent',
			// 320%+ only: glow reaches 1px farther, plus a faint second layer (~+10% overall opacity)
			len: edge ? '1px' : '0px',
			boost: edge ? 'rgba(' + rgb.join(',') + ',0.27)' : 'transparent',
			// Item-name text effect: tight glow, plus a thin red stroke painted behind the fill.
			nameShadow: '0 0 2px rgb(' + rgb.join(',') + '), 0 0 6px rgb(' + rgb.join(',') + ')',
			nameStroke: edge ? '1px rgb(' + EDGE_RGB.join(',') + ')' : '0 transparent'
		};
	}

	// Store the item's colours as CSS variables on an element (they inherit to its children).
	function setColorVars(el, item) {
		if (!el || !el.style) return;
		const k = tierColors(item);
		el.style.setProperty('--dg-c', k.c);
		el.style.setProperty('--dg-glow', k.glow);
		el.style.setProperty('--dg-edge', k.edge);
		el.style.setProperty('--dg-len', k.len);
		el.style.setProperty('--dg-boost', k.boost);
		el.style.setProperty('--dg-name-shadow', k.nameShadow);
		el.style.setProperty('--dg-name-stroke', k.nameStroke);
	}

	// ---- Sound --------------------------------------------------------------
	function getAudio() {
		if (audioCtx) return audioCtx;
		const Ctx = window.AudioContext || window.webkitAudioContext;
		if (!Ctx) return null;
		try { audioCtx = new Ctx(); } catch (e) { audioCtx = null; }
		return audioCtx;
	}

	// Browsers block audio until the user interacts with the page; warm it up on first input.
	function unlockAudioOnInput() {
		const unlock = () => {
			const ctx = getAudio();
			if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
		};
		['pointerdown', 'keydown'].forEach(ev =>
			window.addEventListener(ev, unlock, { once: true, capture: true })
		);
	}

	// BEGIN alert1
	// Recreation of a deep "boom" alert, fitted to a spectral analysis of a reference clip:
	// sub-bass hit (~54-75 Hz) + a sustained ~161 Hz tone with an octave
	// and a pink-noise wash that fades over ~2 s. Edit the [time, level] points to reshape.
	function playAlert1(ctx, dest, t0) {
		const A = 0.08; // onset (seconds of leading silence)
		const out = ctx.createGain();
		out.gain.value = SOUND_VOLUME * 4;
		out.connect(dest);

		function shape(g, pts) {
			g.gain.setValueAtTime(0.0001, t0);
			pts.forEach(([t, v]) => g.gain.exponentialRampToValueAtTime(Math.max(v, 0.0001), t0 + t));
		}

		function tone(freq, pts, endT, glideFrom) {
			const o = ctx.createOscillator();
			const g = ctx.createGain();
			o.type = 'sine';
			if (glideFrom) {
				o.frequency.setValueAtTime(glideFrom, t0 + A);
				o.frequency.exponentialRampToValueAtTime(freq, t0 + A + 0.3);
			} else {
				o.frequency.setValueAtTime(freq, t0);
			}
			shape(g, pts);
			o.connect(g);
			g.connect(out);
			o.start(t0);
			o.stop(t0 + endT);
		}

		// Sub-bass body
		tone(64.6,  [[A, 0.0001], [0.28, 0.20],  [0.56, 0.056], [0.98, 0.016], [1.39, 0.0036], [2.0, 0.002], [2.4, 0.0005]], 2.5, 95);
		tone(53.8,  [[A, 0.0001], [0.30, 0.07],  [0.70, 0.03],  [1.20, 0.006],  [1.90, 0.001]], 2.0);
		tone(129.2, [[A, 0.0001], [0.28, 0.08],  [0.56, 0.04],  [0.98, 0.01],   [1.50, 0.002]], 1.6);
		tone(95.0,  [[A, 0.0001], [0.28, 0.025], [0.56, 0.012], [1.00, 0.004],  [1.50, 0.001], [2.0, 0.0004]], 2.1);
		tone(124.0, [[A, 0.0001], [0.50, 0.02],  [1.00, 0.006],  [1.60, 0.002],  [2.10, 0.0015], [2.4, 0.0006]], 2.5);
		// Sustained tone that swells in behind the hit
		tone(161.5, [[A, 0.0001], [0.30, 0.007], [0.56, 0.018], [0.84, 0.024],  [1.10, 0.015], [1.39, 0.006], [1.60, 0.001], [2.0, 0.0003]], 2.1);
		tone(323.0, [[A, 0.0001], [0.50, 0.006], [0.84, 0.01],  [1.30, 0.003],  [1.70, 0.0005]], 1.8);
		// Pink-noise wash (Paul Kellet filter), low-passed progressively darker
		const len = Math.floor(ctx.sampleRate * 2.4);
		const buf = ctx.createBuffer(1, len, ctx.sampleRate);
		const d = buf.getChannelData(0);
		let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
		for (let i = 0; i < len; i++) {
			const w = Math.random() * 2 - 1;
			b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
			b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
			b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
			d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
			b6 = w * 0.115926;
		}
		const src = ctx.createBufferSource();
		src.buffer = buf;
		const lp = ctx.createBiquadFilter();
		lp.type = 'lowpass';
		lp.frequency.setValueAtTime(14000, t0 + A);
		lp.frequency.exponentialRampToValueAtTime(3000, t0 + 2.2);
		const ng = ctx.createGain();
		shape(ng, [[A, 0.0001], [0.14, 0.012], [0.28, 0.20], [0.5, 0.17], [0.7, 0.10], [1.0, 0.055], [1.4, 0.022], [2.0, 0.005], [2.4, 0.0012]]);
		src.connect(lp);
		lp.connect(ng);
		ng.connect(out);
		src.start(t0);
	}
	// END alert1

	function playChime() {
		if (!SOUND_ENABLED) return;
		const ctx = getAudio();
		if (!ctx) return;
		if (ctx.state === 'suspended') ctx.resume().catch(() => {});
		playAlert1(ctx, ctx.destination, ctx.currentTime + 0.01);
	}

	// ---- Inventory slot highlighting ---------------------------------------
	function itemForElement(el, idx) {
		const $el = window.$(el);
		const fromDom = $el.data('item') || $el.find('.icon').data('item');
		if (fromDom && typeof fromDom === 'object') return fromDom;
		return posMap[idx] || null;
	}

	// Fallback only: add-only, and skips slots already decided by the game's
	// 'beforeRenderItem' event (see onBeforeRenderItem), which is the reliable path.
	function applySlotHighlights() {
		const $slots = window.$(SEL_INV_ITEMS);
		$slots.each(function (idx) {
			if (this.hasAttribute('data-dg-radiant')) return;
			if (this.classList.contains('empty')) return;
			const item = itemForElement(this, idx);
			if (item && isRadiant(item)) {
				window.$(this).addClass('dgRadiant');
				setColorVars(this, item);
			}
		});
	}

	// Remove glow from slots that no longer hold a radiant item. When an item moves away,
	// the game re-renders the old slot as 'empty' and returns before emitting
	// 'beforeRenderItem', so nothing else would ever clear it.
	function clearStaleGlows() {
		window.$('.dgRadiant').each(function () {
			const el = this;
			const item = window.$(el).data('dgItem');
			const stale =
				!document.body.contains(el) ||
				el.classList.contains('empty') ||
				(item && !isRadiant(item));
			if (stale) {
				window.$(el).removeClass('dgRadiant').removeData('dgItem').removeAttr('data-dg-radiant');
			}
		});
		// A slot flagged "not radiant" or left empty shouldn't keep an old item reference.
		window.$('.renderItem.item.empty').each(function () {
			if (this.hasAttribute('data-dg-radiant') || window.$(this).data('dgItem')) {
				window.$(this).removeData('dgItem').removeAttr('data-dg-radiant');
			}
		});
	}

	let slotTimer = null;
	function scheduleSlotHighlights() {
		// Inventory UI re-renders on its own schedule; re-apply a few times to catch it.
		clearTimeout(slotTimer);
		[0, 60, 250].forEach(ms => setTimeout(applySlotHighlights, ms));
	}

	function watchInventory() {
		// Reconcile whenever slots are added/removed or change class (e.g. gain/lose 'empty').
		const root = document.querySelector('.ui-container') || document.body;
		let pending = false;
		const reconcile = () => {
			pending = false;
			clearStaleGlows();
			applySlotHighlights();
		};
		const obs = new MutationObserver(() => {
			if (pending) return;
			pending = true;
			requestAnimationFrame(reconcile);
		});
		obs.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
	}

	// ---- Tooltip name colouring --------------------------------------------
	function clearTooltipMarks() {
		window.$('.dgRadiantTip').removeClass('dgRadiantTip');
		window.$('.dgRadiantName').removeClass('dgRadiantName');
	}

	// Colour the element(s) that actually hold the item's name, found by matching text
	// (so it works whatever the tooltip's class names are), falling back to the heading.
	// Scan the whole page for visible elements whose OWN text contains the item's name
	// (the game's tooltip markup isn't known to us, so we don't rely on its class names),
	// colour them, and mark the enclosing tooltip box too.
	function colourName(item) {
		const base = String(item.originalName || item.name || '').replace(/\s*\[[^\]]*%.*$/, '').trim();
		if (!base) return false;
		let found = false;
		const all = document.body.getElementsByTagName('*');
		for (let i = 0; i < all.length; i++) {
			const el = all[i];
			const tag = el.tagName;
			if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'CANVAS' || tag === 'INPUT') continue;
			// Text that belongs directly to this element (not to its children)
			let own = '';
			for (let c = el.firstChild; c; c = c.nextSibling) {
				if (c.nodeType === 3) own += c.nodeValue;
			}
			if (own.indexOf(base) === -1) continue;
			if (!el.offsetParent && window.getComputedStyle(el).position !== 'fixed') continue; // hidden
			const $el = window.$(el);
			$el.addClass('dgRadiantName');
			setColorVars(el, item);
			const $tip = $el.closest('[class*="ooltip"]').addClass('dgRadiantTip');
			if ($tip.length) setColorVars($tip[0], item);
			found = true;
		}
		return found;
	}

	let tipItem = null;
	let tipTimers = [];

	function cancelTipTimers() {
		tipTimers.forEach(clearTimeout);
		tipTimers = [];
	}

	function markTooltip(item) {
		cancelTipTimers();
		// The game re-emits showItemTooltip on every mouse move; only clear when the item changes.
		if (item !== tipItem) clearTooltipMarks();
		tipItem = item;
		if (!item || !isRadiant(item)) return;
		const apply = () => {
			if (tipItem !== item) return;
			if (!colourName(item)) {
				// Last resort: the first heading/name element inside any visible tooltip-like box
				window.$(SEL_TOOLTIP).filter(':visible').each(function () {
					const $t = window.$(this);
					$t.addClass('dgRadiantTip');
					setColorVars(this, item);
					$t.find('.heading, .name').first().addClass('dgRadiantName');
				});
			}
		};
		// The tooltip UI renders from the same event, possibly after our handler runs.
		[0, 40, 150].forEach(ms => tipTimers.push(setTimeout(apply, ms)));
	}

	function hideTooltipMarks() {
		cancelTipTimers();
		tipItem = null;
		clearTooltipMarks();
	}

	// ---- Addon registration -------------------------------------------------
	defer(() => {
		injectCss();
		unlockAudioOnInput();
		watchInventory();

		window.addons.register({
			init: function ({ events }) {
				events.on('onGetItems', this.onGetItems.bind(this));
				// Current game: the tooltip controller emits 'showItemTooltip' with a config object
				// ({ item, el, pos, ... }). Older builds emitted 'onShowItemTooltip' with the item.
				events.on('showItemTooltip', this.onShowItemTooltip.bind(this));
				events.on('onShowItemTooltip', this.onShowItemTooltip.bind(this));
				events.on('onHideItemTooltip', this.onHideItemTooltip.bind(this));
				// Emitted by renderItem for every item slot, with { el, item }.
				events.on('beforeRenderItem', this.onBeforeRenderItem.bind(this));
			},

			onBeforeRenderItem: function (obj) {
				if (!obj || !obj.el || !obj.item) return;
				const { el, item } = obj;
				el.data('dgItem', item);
				const apply = () => {
					if (el.data('dgItem') !== item) return; // slot was re-rendered with another item or emptied
					const radiant = isRadiant(item);
					el.attr('data-dg-radiant', radiant ? '1' : '0').toggleClass('dgRadiant', radiant);
					if (radiant) setColorVars(el[0], item);
				};
				apply();
				// The tier addon may only set item.dgTier (in place) after the slot was first drawn.
				setTimeout(apply, 0);
				setTimeout(apply, 150);
			},

			onGetItems: function (items) {
				if (!items || !Array.isArray(items)) return;

				// Defer until every other onGetItems handler (e.g. DG Perf Tiers) has set item.dgTier.
				setTimeout(() => {
					const isFullRefresh = items.length > 1;
					if (isFullRefresh) {
						for (const k in posMap) delete posMap[k];
					}

					const now = Date.now();
					if (!baselineDone) {
						baselineDone = true;
						baselineTime = now;
					}
					const inGrace = now - baselineTime < BASELINE_GRACE_MS;

					let playSound = false;
					for (const item of items) {
						if (!item) continue;
						if (!item.eq && item.pos !== undefined && item.pos !== null) {
							posMap[item.pos] = item;
						}

						if (item.id === undefined || item.id === null) continue;
						const isNew = !seenIds.has(item.id);
						seenIds.add(item.id);
						if (isNew && !inGrace && !item.eq && !item.material && isRadiant(item)) {
							playSound = true;
						}
					}

					if (playSound) playChime();
					scheduleSlotHighlights();
				}, 0);
			},

			onShowItemTooltip: function (arg) {
				// Accept either the game's config object or a bare item.
				const item = arg && arg.item ? arg.item : arg;
				markTooltip(item);
			},

			onHideItemTooltip: function () {
				hideTooltipMarks();
			}
		});
	});
})();
