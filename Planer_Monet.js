/*
 * Planer Monet v1.5.0
 * Autor: Mavionis
 *
 * Przegląd > Budynki: uruchom skrypt. (Na innym ekranie przenosi do Przeglądu > Budynki ze wszystkimi wioskami.)
 *
 * Pomaga w biciu złotych monet:
 *  - sam wybiera, w których Pałacach bić monety: jak najmniej Pałaców (mniej flag do pilnowania, większe grupy),
 *    tak, żeby najdłuższa trasa kupców nie przekroczyła ustawionej (domyślnie 4,5 pola); reszta wysyła do najbliższego.
 *    Działa też, gdy Pałac jest prawie wszędzie,
 *  - pomija wioski leżące daleko od wszystkich Pałaców (np. osobna wyspa),
 *  - układa wioski z Pałacem w ranking: gdzie założyć najlepszą flagę „Obniżenie kosztu monet” i gdzie Bonus flagi,
 *  - wskazuje, gdzie zbudować nowy Pałac, żeby najbardziej skrócić trasy (z wymaganiami: Ratusz 20, Kuźnia 20, Rynek 10).
 * Skrypt tylko czyta stronę i liczy – niczego nie buduje, nie wysyła i nie zmienia w grze.
 */
(function () {
	'use strict';

	const NAME = 'Planer Monet';
	const VERSION = 'v1.5.0';
	const NS = 'PlanerMonet';
	const COIN = { wood: 28000, stone: 30000, iron: 25000 };   // koszt 1 monety bez flagi
	const PACKAGE = 0.10;                                        // pakiet surowców: 10% pojemności spichlerza
	const TOP_FLAG = 0.23;                                       // fioletowa flaga; z Bonusem flagi −46%
	const PALACE_REQ = { main: 20, smith: 20, market: 10 };
	const REQ_NAMES = { main: 'Ratusz', smith: 'Kuźnia', market: 'Rynek' };

	const DEFAULTS = { skip: '', useQueued: true, bonusMin: 6, choice: null, far: 4.5 };

	// ---------- Narzędzia ----------
	const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
	const notify = (msg, type = 'InfoMessage') => {
		if (typeof UI !== 'undefined' && UI[type]) { UI[type](esc(msg)); } else { alert(msg); }
	};
	const storageKey = key => `${NS}_${game_data.world}_${game_data.player.id}_${key}`;
	const storageGet = key => { try { return JSON.parse(localStorage.getItem(storageKey(key))); } catch (e) { return null; } };
	const storageSet = (key, val) => { try { localStorage.setItem(storageKey(key), JSON.stringify(val)); } catch (e) { /* brak miejsca */ } };
	const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
	const fmt = n => Math.round(n).toLocaleString('pl-PL');
	const f1 = n => n.toFixed(1).replace('.', ',');
	// pojemność spichlerza z poziomu (poziom 30 = 400 000)
	const storageCap = lvl => (lvl > 0 ? Math.round(1000 * Math.pow(1.2294934, lvl - 1)) : 0);

	function loadSettings() {
		const s = Object.assign({}, DEFAULTS, storageGet('ustawienia') || {});
		s.bonusMin = Math.max(1, parseInt(s.bonusMin, 10) || DEFAULTS.bonusMin);
		s.choice = Number(s.choice) || null;
		s.far = Math.max(1, Number(String(s.far).replace(',', '.')) || DEFAULTS.far);
		return s;
	}

	// „101-106, 002, Wioska 004” → test nazwy wioski (numer z końca nazwy albo cała nazwa)
	function nameMatcher(text) {
		const parts = String(text || '').split(/[,;\n]+/).map(p => p.trim()).filter(Boolean);
		const ranges = [], names = [];
		parts.forEach(p => {
			const m = p.match(/^(\d+)\s*[-–]\s*(\d+)$/);
			if (m) { ranges.push([Number(m[1]), Number(m[2])]); }
			else if (/^\d+$/.test(p)) { ranges.push([Number(p), Number(p)]); }
			else { names.push(p.toLowerCase()); }
		});
		return v => {
			const n = (v.name.match(/(\d+)\s*$/) || [])[1];
			return names.includes(v.name.toLowerCase()) || (n !== undefined && ranges.some(([a, b]) => Number(n) >= a && Number(n) <= b));
		};
	}

	// ---------- Wioski z Przeglądu > Budynki ----------
	function readVillages() {
		const list = [];
		$('#buildings_table tr.vrow, #buildings_table tr[id^="v_"]').each(function () {
			const tr = $(this);
			const label = tr.find('.quickedit-label').first();
			const name = String(label.data('text') ?? label.attr('data-text') ?? '').trim();
			const m = label.text().match(/\((\d{1,3})\|(\d{1,3})\)\s*K\d+\s*$/);
			if (!m) { return; }
			const lvl = b => parseInt(tr.find('td.b_' + b).first().text(), 10) || 0;
			const queuedPalace = tr.find('.queue_icon img[src*="buildings/snob."]').length > 0;
			list.push({
				id: Number(String(tr.attr('id') || '').replace('v_', '')), name,
				x: Number(m[1]), y: Number(m[2]),
				main: lvl('main'), smith: lvl('smith'), market: lvl('market'), storage: lvl('storage'),
				palace: lvl('snob') > 0, queuedPalace
			});
		});
		return list;
	}

	// ---------- Obliczenia ----------
	// przypisanie wiosek wysyłających do najbliższego Pałacu
	function assign(villages, palaces) {
		const groups = new Map(palaces.map(p => [p.id, { palace: p, senders: [] }]));
		let longest = null;
		villages.forEach(v => {
			if (groups.has(v.id)) { return; }
			let best = null, bd = Infinity;
			palaces.forEach(p => { const d = dist(v, p); if (d < bd - 1e-9 || (Math.abs(d - bd) < 1e-9 && p.id < best.id)) { bd = d; best = p; } });
			if (!best) { return; }
			groups.get(best.id).senders.push({ v, d: bd });
			if (!longest || bd > longest.d) { longest = { v, p: best, d: bd }; }
		});
		const all = [...groups.values()].flatMap(g => g.senders);
		return { groups: [...groups.values()], longest, avg: all.length ? all.reduce((t, s) => t + s.d, 0) / all.length : 0 };
	}

	// surowce i monety na jedną falę pakietów (glina ogranicza – moneta potrzebuje jej najwięcej)
	function coinsPerWave(group, discount) {
		const members = [group.palace, ...group.senders.map(s => s.v)];
		const res = members.reduce((t, v) => t + storageCap(v.storage) * PACKAGE, 0);
		const per = Object.keys(COIN).map(r => res / (COIN[r] * (1 - discount)));
		return { res, coins: Math.floor(Math.min(...per)) };
	}

	function analyse(villages, s) {
		const skip = nameMatcher(s.skip);
		const isPalace = v => v.palace || (s.useQueued && v.queuedPalace);
		const allPalaces = villages.filter(v => isPalace(v) && !skip(v));
		if (!allPalaces.length) { throw 'nie ma żadnej wioski z Pałacem.'; }
		// wioski dalej niż s.far pól od każdego Pałacu nie biorą udziału (np. osobna wyspa)
		const tooFar = villages.filter(v => !skip(v) && !isPalace(v) && Math.min(...allPalaces.map(p => dist(v, p))) > s.far);
		const active = villages.filter(v => !skip(v) && !tooFar.includes(v));
		// Warianty: ile Pałaców bije monety i jaka jest wtedy najdłuższa trasa kupców. Mniej Pałaców = mniej flag
		// do pilnowania i większe grupy, ale dłuższe trasy i wolniejsze fale. Zdjęty Pałac wysyła surowce jak zwykła wioska.
		const best = assign(active, allPalaces);
		const variants = new Map(); // liczba Pałaców → { palaces, longest }
		const keep = (list) => {
			const r = assign(active, list);
			const d = r.longest ? r.longest.d : 0;
			if (d > s.far + 1e-9) { return; }
			const old = variants.get(list.length);
			if (!old || d < old.longest - 1e-9) { variants.set(list.length, { palaces: list.slice(), longest: d }); }
		};
		keep(allPalaces);
		// 1) zdejmowanie po kolei Pałacu, bez którego najdłuższa trasa rośnie najmniej
		let cur = allPalaces.slice();
		while (cur.length > 1) {
			let pick = null;
			cur.forEach(p => {
				const r = assign(active, cur.filter(q => q !== p));
				const d = r.longest ? r.longest.d : 0;
				if (!pick || d < pick.d - 1e-9 || (Math.abs(d - pick.d) < 1e-9 && r.avg < pick.avg)) { pick = { p, d, avg: r.avg }; }
			});
			cur = cur.filter(q => q !== pick.p);
			keep(cur);
		}
		// 2) dla progów co 0,5 pola: po kolei Pałac, który obejmie najwięcej jeszcze nieobjętych wiosek
		for (let limit = Math.ceil((best.longest ? best.longest.d : 0) * 2) / 2; limit <= s.far; limit += 0.5) {
			const cover = [];
			let left = active.slice();
			while (left.length) {
				let pick = null, got = [];
				allPalaces.forEach(p => {
					if (cover.includes(p)) { return; }
					const inRange = left.filter(v => dist(v, p) <= limit + 1e-9);
					if (inRange.length > got.length) { pick = p; got = inRange; }
				});
				if (!pick) { break; }
				cover.push(pick);
				left = left.filter(v => !got.includes(v));
			}
			if (!left.length) { keep(cover); }
		}
		// tylko warianty, w których mniej Pałaców naprawdę wydłuża trasę mniej niż wariant z jeszcze mniejszą liczbą
		const list = [...variants.entries()].map(([count, v]) => Object.assign({ count }, v)).sort((a, b) => b.count - a.count)
			.filter((v, i, arr) => !arr.some(o => o.count < v.count && o.longest <= v.longest + 1e-9));
		// zalecany: najmniej Pałaców, przy których żadna trasa nie przekracza „Kupcy najdalej”
		const recommended = list[list.length - 1];
		const chosen = list.find(v => v.count === s.choice) || recommended;
		const palaces = chosen.palaces;
		const resting = allPalaces.filter(p => !palaces.includes(p));
		const now = assign(active, palaces);
		// ranking: najwięcej surowców na falę → najlepsza flaga
		const ranking = now.groups.map(g => {
			const base = coinsPerWave(g, 0), top = coinsPerWave(g, TOP_FLAG), bonus = coinsPerWave(g, 2 * TOP_FLAG);
			return Object.assign(g, { base, top, bonus, far: g.senders.reduce((m, x) => Math.max(m, x.d), 0) });
		}).sort((a, b) => b.base.res - a.base.res || b.senders.length - a.senders.length || a.palace.id - b.palace.id);
		// gdzie nowy Pałac: każda wioska bez Pałacu jako kandydat
		const candidates = active.filter(v => !isPalace(v)).map(c => {
			const after = assign(active, palaces.concat(c));
			const g = after.groups.find(x => x.palace.id === c.id);
			const missing = Object.keys(PALACE_REQ).filter(k => c[k] < PALACE_REQ[k]).map(k => `${REQ_NAMES[k]} ${c[k]}/${PALACE_REQ[k]}`);
			return { c, after, takes: g.senders.length, missing };
		}).sort((a, b) => a.after.longest.d - b.after.longest.d || a.after.avg - b.after.avg || b.takes - a.takes)
			.slice(0, 5);
		return { active, skipped: villages.length - active.length - tooFar.length, tooFar, palaces, resting, best, now, ranking, candidates, variants: list, recommended, chosen };
	}

	// ---------- Panel ----------
	function render(s, villages) {
		$('#' + NS).remove();
		if (!$('#' + NS + '_css').length) {
			$('head').append(`<style id="${NS}_css">#${NS} label{display:inline;margin:0;white-space:nowrap}#${NS} input[type=text]{vertical-align:middle}
				#${NS} input[type=checkbox]{vertical-align:middle;margin:0 3px 0 0}#${NS} small{color:#5a4a2a}#${NS} td.num{text-align:right}</style>`);
		}
		$($('#content_value').length ? '#content_value' : '#mobileContent').first().prepend(`
			<div id="${NS}" class="vis" style="padding:8px;margin-bottom:10px">
				<h3 style="margin:0 0 6px 0">${NAME} <small>${VERSION}</small></h3>
				<table class="vis" style="width:100%">
					<tr><th colspan="2">Ustawienia</th></tr>
					<tr><td style="width:210px">Pomiń wioski</td><td><input type="text" id="${NS}_skip" value="${esc(s.skip)}" style="width:220px" placeholder="np. 101-106">
						<small>– opcjonalnie; te wioski nie biorą udziału. Wpisz numery z końca nazwy po przecinku: „7, 12” albo od–do: „101-106” (= wioski 101, 102 … 106)</small></td></tr>
					<tr><td>Kupcy najdalej</td><td>do <input type="text" id="${NS}_far" value="${String(s.far).replace('.', ',')}" style="width:35px"> pól
						<small>– skrypt wybierze jak najmniej Pałaców, przy których żadna trasa nie będzie dłuższa. Mniej pól = szybsze fale, ale więcej Pałaców i flag; więcej pól = mniej Pałaców. Wioski dalej od każdego Pałacu pomijam</small></td></tr>
					<tr><td>Pałac w budowie</td><td><label><input type="checkbox" id="${NS}_queued" ${s.useQueued ? 'checked' : ''}> licz jak gotowy Pałac</label></td></tr>
					<tr><td>Bonus flagi</td><td>gdy grupa ma co najmniej <input type="text" id="${NS}_bonus" value="${s.bonusMin}" style="width:30px"> wiosek wysyłających</td></tr>
				</table>
				<div id="${NS}_out"></div>
			</div>`);
		const redraw = () => {
			const cur = {
				skip: String($(`#${NS}_skip`).val()),
				choice: (storageGet('ustawienia') || {}).choice || null,
				far: Math.max(1, Number(String($(`#${NS}_far`).val()).replace(',', '.')) || DEFAULTS.far),
				useQueued: $(`#${NS}_queued`).is(':checked'), bonusMin: Math.max(1, parseInt($(`#${NS}_bonus`).val(), 10) || DEFAULTS.bonusMin)
			};
			storageSet('ustawienia', cur);
			try { $(`#${NS}_out`).html(results(analyse(villages, cur), cur)); }
			catch (ex) { $(`#${NS}_out`).html(`<p style="color:#b00"><b>${esc(typeof ex === 'string' ? ex : 'błąd obliczeń.')}</b></p>`); if (typeof ex !== 'string') { console.error(NAME, ex); } }
		};
		$('#' + NS).on('change', `#${NS}_far`, () => { storageSet('ustawienia', Object.assign(loadSettings(), { choice: null })); });
		$('#' + NS).on('input change', 'input:not([readonly])', redraw);
		$('#' + NS).on('click', `.${NS}_choose`, function (e) {
			e.preventDefault();
			storageSet('ustawienia', Object.assign(loadSettings(), { choice: Number($(this).data('count')) }));
			redraw();
		});
		// [współrzędne]: pokaż listę „x|y x|y …” do skopiowania i spróbuj wstawić ją do schowka
		$('#' + NS).on('click', `.${NS}_copy`, function (e) {
			e.preventDefault();
			const text = String($(this).data('coords'));
			const box = $(`#${NS}_copybox`).show();
			box.find('input').val(text).trigger('focus').trigger('select');
			try { navigator.clipboard && navigator.clipboard.writeText(text).catch(() => {}); } catch (ex) { /* zostaje ręczne kopiowanie */ }
		});
		redraw();
	}

	function results(a, s) {
		const L = a.now.longest;
		const tag = v => esc(v.name) + (v.queuedPalace && !v.palace ? ' <small>(w budowie)</small>' : '');
		const rank = a.ranking.map((g, i) => {
			const bonus = g.senders.length >= s.bonusMin;
			return `<tr>
				<td class="num">${i + 1}.</td><td><b>${tag(g.palace)}</b></td>
				<td class="num">${g.senders.length || '<small>sama</small>'}</td>
				<td class="num">${g.senders.length ? f1(g.far) : '–'}</td>
				<td class="num">${fmt(g.base.res)}</td>
				<td class="num">${fmt(g.base.coins)} → ${fmt(g.top.coins)}</td>
				<td>${i === 0 ? '<b>najlepsza</b>' : `${i + 1}. najlepsza`}</td>
				<td>${bonus ? `<b style="color:#060">TAK</b> <small>+${fmt(g.bonus.coins - g.top.coins)} monet/falę</small>` : '<small>nie</small>'}</td>
				<td>${g.senders.length ? g.senders.slice().sort((p, q) => p.d - q.d).map(x => `${esc(x.v.name)} <small>(${f1(x.d)})</small>`).join(', ')
					+ ` <a href="#" class="${NS}_copy" data-coords="${g.senders.map(x => `${x.v.x}|${x.v.y}`).join(' ')}" title="współrzędne do „Dodaj współrzędne” w grupach ręcznych">[współrzędne]</a>` : '<small>tylko własne surowce</small>'}</td></tr>`;
		}).join('');
		const cand = a.candidates.map(x => `<tr>
			<td><b>${esc(x.c.name)}</b> <small>${x.c.x}|${x.c.y}</small></td>
			<td class="num">${f1(x.after.longest.d)} <small>(teraz ${f1(L.d)})</small></td>
			<td class="num">${f1(x.after.avg)} <small>(teraz ${f1(a.now.avg)})</small></td>
			<td class="num">${x.takes}</td>
			<td>${x.missing.length ? `<span style="color:#b00">brakuje: ${x.missing.join(', ')}</span>` : '<span style="color:#060">spełnia wymagania</span>'}</td></tr>`).join('');
		const variants = a.variants.map(v => `<tr${v === a.chosen ? ' style="font-weight:bold"' : ''}>
			<td class="num">${v.count}</td><td class="num">${f1(v.longest)}</td>
			<td>${v === a.recommended ? '<b style="color:#060">zalecany</b>' : ''}</td>
			<td>${v === a.chosen ? '✓ wybrany' : `<a href="#" class="${NS}_choose" data-count="${v.count}">wybierz</a>`}</td></tr>`).join('');
		return `
			<details style="margin:8px 0 0 0" ${a.chosen !== a.recommended ? 'open' : ''}><summary style="cursor:pointer"><b>Ile Pałaców ma bić monety?</b>
				<small>Wybrany wariant: ${a.chosen.count} Pałaców, najdłuższa trasa ${f1(a.chosen.longest)} pola – kliknij, żeby porównać</small></summary>
				<table class="vis" style="margin-top:4px">
					<tr><th>Pałaców</th><th>Najdłuższa trasa (pola)</th><th></th><th></th></tr>${variants}</table>
				<small>Mniej Pałaców = mniej flag do pilnowania i większe grupy, ale dłuższe trasy kupców i wolniejsze fale.
					Zalecany = najmniej Pałaców w zasięgu „Kupcy najdalej”.</small></details>
			<p style="margin:8px 0 4px 0">Bij monety w <b>${a.palaces.length}</b> Pałacach, wysyłające: <b>${a.active.length - a.palaces.length}</b>${a.skipped ? `, pominięte: ${a.skipped}` : ''}.
				${a.resting.length ? `<br>Pałace, które lepiej niech <b>wysyłają</b>, a nie biją: <b>${a.resting.length <= 12 ? a.resting.map(v => esc(v.name)).join(', ') : a.resting.length + ' wiosek'}</b> <small>– wysyłają surowce jak zwykłe wioski</small>` : ''}
				${a.tooFar.length ? `<br>Za daleko od Pałaców, pomijam: <small>${a.tooFar.map(v => esc(v.name)).join(', ')}</small>` : ''}<br>
				Najdłuższa trasa: <b>${L ? `${f1(L.d)} pola` : '–'}</b>${L ? ` <small>(${esc(L.v.name)} → ${esc(L.p.name)}) – to ona wyznacza tempo fal</small>` : ''}</p>
			<table class="vis" style="width:100%">
				<tr><th colspan="9">Gdzie bić monety, skąd brać surowce, jaka flaga</th></tr>
				<tr><th>#</th><th>Bij monety w</th><th>Wiosek wysył.</th><th>Najdalej (pola)</th><th>Surowce/falę<br><small>każdego rodzaju</small></th>
					<th>Monet/falę<br><small>bez flagi → fioletowa</small></th><th>Flaga</th><th>Bonus flagi<br><small>przy fioletowej</small></th><th>Pobieraj surowce z <small>(odległość)</small></th></tr>
				${rank}
			</table>
			<p style="margin:4px 0 2px 0">Współrzędne wszystkich Pałaców do bicia (np. grupa „Monety”): <a href="#" class="${NS}_copy" data-coords="${a.ranking.map(g => `${g.palace.x}|${g.palace.y}`).join(' ')}">[współrzędne]</a></p>
			<div id="${NS}_copybox" style="display:none;margin:2px 0"><input type="text" readonly style="width:95%"> <br><small>Skopiowane do schowka (jeśli przeglądarka pozwoliła) – wklej w Grupy &gt; Ręczne grupy &gt; „Dodaj współrzędne”.</small></div>
			<p style="margin:4px 0 8px 0"><small>Najlepszą flagę „Obniżenie kosztu monet” zakładaj na 1. miejscu, drugą na 2. itd. Fala = pakiet surowców (10% spichlerza) w każdej wiosce grupy.
				Bonus flagi opłaca się przy intensywnych falach (ok. 30+ pakietów w 48 h); zmiana flagi kasuje bonus.</small></p>
			<table class="vis" style="width:100%">
				<tr><th colspan="5">Gdzie zbudować nowy Pałac – 5 najlepszych miejsc</th></tr>
				<tr><th>Wioska</th><th>Najdłuższa trasa</th><th>Średnia trasa</th><th>Przejmie wiosek</th><th>Wymagania</th></tr>
				${cand || '<tr><td colspan="5"><small>każda wioska ma już Pałac</small></td></tr>'}
			</table>`;
	}

	// ---------- Start ----------
	function main() {
		if (typeof game_data === 'undefined') { notify(`${NAME}: uruchom skrypt w grze.`); return; }
		const url = location.href;
		const onBuildings = game_data.screen === 'overview_villages' && $('#buildings_table').length > 0;
		// zawsze wszystkie wioski: strona „wszystkie” i grupa „wszystkie” (gra pamięta ostatnio wybraną grupę)
		const allGroup = String(game_data.group_id ?? '0') === '0';
		if (!onBuildings || !/[?&]page=-1(&|$)/.test(url) || !allGroup) {
			const t = game_data.player.sitter && Number(game_data.player.sitter) > 0 ? '&t=' + game_data.player.id : '';
			location.href = `/game.php?village=${game_data.village.id}${t}&screen=overview_villages&mode=buildings&group=0&page=-1`;
			return;
		}
		const villages = readVillages();
		if (!villages.length) { notify(`${NAME}: nie znalazłem wiosek w tabeli budynków.`, 'ErrorMessage'); return; }
		render(loadSettings(), villages);
	}

	if (Date.now() - (window[NS + '_lastRun'] || 0) < 500) { return; } // gra potrafi wykonać skrót dwa razy naraz
	window[NS + '_lastRun'] = Date.now();
	try { main(); } catch (ex) {
		notify(`${NAME}: błąd – ${ex && ex.message ? ex.message : ex}`, 'ErrorMessage');
		console.error(NAME, ex);
	}
})();
