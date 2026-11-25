/*
 * Licznik Fejków v1.0.0
 * Autor: Mavionis
 *
 * Przegląd > Rozkazy: uruchom skrypt. (Na innym ekranie przenosi do Przeglądu > Rozkazy ze wszystkimi rozkazami.)
 *
 * Liczy wysłane fejki – ataki z małą liczbą taranów/katapult (ustawiane w panelu):
 *  - w drodze teraz (z tabeli rozkazów),
 *  - wysłane dzisiaj / wczoraj / w ostatnich 7 dniach / wszystkie od pierwszego uruchomienia.
 * Godzinę wysłania wylicza z godziny dotarcia minus czas marszu (odległość × prędkość najwolniejszej jednostki).
 * Gra nie przechowuje historii rozkazów, więc skrypt zapisuje w przeglądarce numery fejków, które już widział.
 * Fejk, który dotrze i wróci między dwoma uruchomieniami, nie zostanie policzony – uruchamiaj skrypt raz dziennie.
 *
 * Skrypt tylko czyta stronę – niczego nie wysyła ani nie klika. Jedyne zapytanie: prędkości jednostek
 * z serwera gry (interface.php, raz na świat). Nie łączy się z niczym poza serwerem gry.
 */
(function () {
	'use strict';

	const NAME = 'Licznik Fejków';
	const VERSION = 'v1.0.0';
	const NS = 'LicznikFejkow';
	const KEEP_DAYS = 30;                // tyle dni trzymamy numery rozkazów; starsze zostają tylko jako liczby dzienne
	const DAY = 86400000;

	const DEFAULTS = { siegeMin: 1, siegeMax: 15, unitsMax: 1000 };
	const UNITS = ['spear', 'sword', 'axe', 'archer', 'spy', 'light', 'marcher', 'heavy', 'ram', 'catapult', 'knight', 'snob'];

	// ---------- Narzędzia ----------
	const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
	const notify = (msg, type = 'InfoMessage') => {
		if (typeof UI !== 'undefined' && UI[type]) { UI[type](esc(msg)); } else { alert(msg); }
	};
	const storageKey = key => `${NS}_${game_data.world}_${game_data.player.id}_${key}`;
	const storageGet = key => { try { return JSON.parse(localStorage.getItem(storageKey(key))); } catch (e) { return null; } };
	const storageSet = (key, val) => { try { localStorage.setItem(storageKey(key), JSON.stringify(val)); } catch (e) { /* brak miejsca */ } };
	const pad = n => String(n).padStart(2, '0');
	// Czas gry trzymamy jako „czas serwera zapisany jak UTC” – bez przesunięć strefy przeglądarki.
	const dayKey = t => { const d = new Date(t); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
	const dayLabel = k => { const [y, m, d] = k.split('-'); return `${d}.${m}.${y}`; };

	function loadSettings() {
		const s = Object.assign({}, DEFAULTS, storageGet('settings') || {});
		s.siegeMin = Math.max(1, parseInt(s.siegeMin, 10) || DEFAULTS.siegeMin);
		s.siegeMax = Math.max(s.siegeMin, parseInt(s.siegeMax, 10) || DEFAULTS.siegeMax);
		s.unitsMax = Math.max(1, parseInt(s.unitsMax, 10) || DEFAULTS.unitsMax);
		return s;
	}

	// Data i godzina serwera z paska gry (#serverDate „25/11/2026”, #serverTime „12:59:00”)
	function serverNow() {
		const d = ($('#serverDate').text().match(/(\d+)\/(\d+)\/(\d+)/) || []).slice(1).map(Number);
		const t = ($('#serverTime').text().match(/(\d+):(\d+):(\d+)/) || []).slice(1).map(Number);
		if (d.length !== 3 || t.length !== 3) { throw 'nie odczytałem czasu serwera.'; }
		return Date.UTC(d[2], d[1] - 1, d[0], t[0], t[1], t[2]);
	}

	// „dzisiaj o 14:59:19:896”, „jutro o 08:00:01:295”, „dnia 27.11. o 08:14:59:000” → czas serwera
	function parseArrival(text, now) {
		const m = text.match(/(\d{1,2}):(\d{2}):(\d{2})(?::(\d{3}))?/);
		if (!m) { return null; }
		const n = new Date(now);
		let y = n.getUTCFullYear(), mo = n.getUTCMonth(), d = n.getUTCDate();
		const dm = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})?/);
		if (dm) {
			d = Number(dm[1]); mo = Number(dm[2]) - 1;
			if (dm[3]) { y = Number(dm[3]) < 100 ? 2000 + Number(dm[3]) : Number(dm[3]); }
			else if (mo < n.getUTCMonth() - 6) { y++; } // np. 02.01. widziane w grudniu
		} else if (/jutro|tomorrow/i.test(text)) {
			d += 1;
		}
		return Date.UTC(y, mo, d, Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] || 0));
	}

	const coordsOf = text => {
		const all = [...String(text).matchAll(/(\d{1,3})\|(\d{1,3})/g)];
		const m = all[all.length - 1];
		return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
	};

	// ---------- Prędkości jednostek (min/pole) z serwera gry, raz na świat ----------
	async function unitSpeeds() {
		const cached = storageGet('speeds');
		if (cached && cached.spear) { return cached; }
		const xml = await $.get('/interface.php?func=get_unit_info');
		const speeds = {};
		$(xml).find('config').children().each(function () {
			const v = parseFloat($(this).find('speed').first().text());
			if (v > 0) { speeds[this.nodeName] = v; }
		});
		if (!speeds.ram) { throw 'nie odczytałem prędkości jednostek.'; }
		storageSet('speeds', speeds);
		return speeds;
	}

	// ---------- Rozkazy z tabeli ----------
	function readCommands(now) {
		const table = $('#commands_table');
		// kolejność kolumn jednostek z nagłówka (obrazki unit_xxx)
		const cols = table.find('tr').first().find('th').map(function () {
			const m = ($(this).find('img').attr('src') || '').match(/unit_(\w+)\./);
			return m ? m[1] : null;
		}).get().filter(Boolean);
		const list = [];
		table.find('tr').slice(1).each(function () {
			const tr = $(this);
			const span = tr.find('[data-command-id]').first();
			const id = Number(span.data('command-id'));
			const type = String(span.data('command-type') || '');
			if (!id || (type !== 'attack' && type !== 'return')) { return; }
			const units = {};
			tr.find('td.unit-item').each(function (i) { if (cols[i]) { units[cols[i]] = parseInt($(this).text(), 10) || 0; } });
			const tds = tr.children('td');
			list.push({
				id, type, units,
				target: coordsOf(tr.find('.quickedit-label').first().text()),
				source: coordsOf(tds.eq(1).text()),
				arrival: parseArrival(tds.eq(2).text(), now),
				label: $.trim(tr.find('.quickedit-label').first().text())
			});
		});
		return list;
	}

	const siegeOf = c => (c.units.ram || 0) + (c.units.catapult || 0);
	const totalOf = c => UNITS.reduce((t, u) => t + (c.units[u] || 0), 0);
	const isFake = (c, s) => siegeOf(c) >= s.siegeMin && siegeOf(c) <= s.siegeMax && totalOf(c) <= s.unitsMax;

	// godzina wysłania = dotarcie − czas marszu (powrót: − 2 × czas marszu)
	function sentTime(c, speeds) {
		if (!c.arrival || !c.source || !c.target) { return null; }
		const slowest = Math.max(...UNITS.filter(u => c.units[u] > 0).map(u => speeds[u] || 0));
		if (!(slowest > 0)) { return null; }
		const dist = Math.hypot(c.source.x - c.target.x, c.source.y - c.target.y);
		const travel = Math.round(dist * slowest * 60) * 1000;
		return c.arrival - (c.type === 'return' ? 2 * travel : travel);
	}

	// ---------- Dziennik ----------
	// log: { seen: { id: czasWysłania }, days: { 'RRRR-MM-DD': liczba starszych fejków }, since: czas pierwszego uruchomienia }
	function loadLog(now) {
		const log = storageGet('log') || {};
		log.seen = log.seen || {};
		log.days = log.days || {};
		log.since = log.since || now;
		return log;
	}

	function updateLog(log, fakes, speeds, now) {
		let added = 0;
		fakes.forEach(c => {
			if (log.seen[c.id] !== undefined) { return; }
			log.seen[c.id] = sentTime(c, speeds) ?? now; // bez współrzędnych – liczymy jako wysłany teraz
			added++;
		});
		// numery starsze niż KEEP_DAYS zamieniamy na liczby dzienne (taki rozkaz nie może już być w przeglądzie)
		Object.keys(log.seen).forEach(id => {
			const t = log.seen[id];
			if (now - t > KEEP_DAYS * DAY) { const k = dayKey(t); log.days[k] = (log.days[k] || 0) + 1; delete log.seen[id]; }
		});
		return added;
	}

	function countsByDay(log) {
		const days = Object.assign({}, log.days);
		Object.values(log.seen).forEach(t => { const k = dayKey(t); days[k] = (days[k] || 0) + 1; });
		return days;
	}

	// ---------- Panel ----------
	function render(s, data) {
		$('#' + NS).remove();
		if (!$('#' + NS + '_css').length) {
			$('head').append(`<style id="${NS}_css">#${NS} label{display:inline;margin:0;white-space:nowrap}#${NS} input[type=text]{vertical-align:middle}#${NS} small{color:#5a4a2a}</style>`);
		}
		const { now, fakes, returning, days, log, added } = data;
		const today = dayKey(now), yesterday = dayKey(now - DAY);
		const week = Object.keys(days).filter(k => k > dayKey(now - 7 * DAY)).reduce((t, k) => t + days[k], 0);
		const total = Object.values(days).reduce((t, n) => t + n, 0);
		const lastDays = Object.keys(days).sort().reverse().slice(0, 14);
		$($('#content_value').length ? '#content_value' : '#mobileContent').first().prepend(`
			<div id="${NS}" class="vis" style="padding:8px;margin-bottom:10px">
				<h3 style="margin:0 0 6px 0">${NAME} <small>${VERSION}</small></h3>
				<table class="vis" style="width:100%">
					<tr><th colspan="2">Fejki</th></tr>
					<tr><td style="width:190px">W drodze teraz</td><td><b>${fakes - returning}</b>${returning ? ` <small>(+ ${returning} wracających)</small>` : ''}</td></tr>
					<tr><td>Wysłane dzisiaj</td><td><b style="font-size:13px">${days[today] || 0}</b></td></tr>
					<tr><td>Wysłane wczoraj</td><td><b>${days[yesterday] || 0}</b></td></tr>
					<tr><td>Ostatnie 7 dni</td><td><b>${week}</b></td></tr>
					<tr><td>Wszystkie</td><td><b>${total}</b> <small>– liczone od ${dayLabel(dayKey(log.since))}</small></td></tr>
				</table>
				<p style="margin:6px 0"><small>Nowych w tym uruchomieniu: <b>${added}</b>. Gra nie przechowuje historii rozkazów – fejk, który dotrze i wróci między dwoma uruchomieniami skryptu, nie zostanie policzony, więc uruchamiaj go co najmniej raz dziennie.</small></p>
				${lastDays.length ? `<details><summary style="cursor:pointer"><b>Dzień po dniu</b></summary>
					<table class="vis" style="margin-top:4px"><tr><th>Dzień</th><th>Wysłane fejki</th></tr>
					${lastDays.map(k => `<tr><td>${dayLabel(k)}</td><td style="text-align:right">${days[k]}</td></tr>`).join('')}</table></details>` : ''}
				<table class="vis" style="width:100%;margin-top:6px">
					<tr><th colspan="2">Co liczyć jako fejk</th></tr>
					<tr><td style="width:190px">Taranów + katapult</td><td>od <input type="text" id="${NS}_smin" value="${s.siegeMin}" style="width:30px"> do <input type="text" id="${NS}_smax" value="${s.siegeMax}" style="width:30px"></td></tr>
					<tr><td>Wszystkich jednostek</td><td>do <input type="text" id="${NS}_umax" value="${s.unitsMax}" style="width:45px"> <small>– 1000 = „Mały atak” w grze</small></td></tr>
					<tr><td colspan="2"><small>Zmiana ustawień działa od następnego uruchomienia – fejki już policzone zostają.</small></td></tr>
				</table>
				<div style="margin-top:6px"><a href="#" id="${NS}_reset">wyzeruj licznik</a> <span id="${NS}_resetask"></span></div>
			</div>`);
		$('#' + NS).on('input', 'input[type=text]', () => {
			storageSet('settings', { siegeMin: $(`#${NS}_smin`).val(), siegeMax: $(`#${NS}_smax`).val(), unitsMax: $(`#${NS}_umax`).val() });
		});
		// zerowanie w dwóch kliknięciach (bez okienek przeglądarki)
		$(`#${NS}_reset`).on('click', e => {
			e.preventDefault();
			$(`#${NS}_resetask`).html(`– na pewno? <a href="#" id="${NS}_resetyes"><b>tak, wyzeruj</b></a>`);
			$(`#${NS}_resetyes`).on('click', ev => {
				ev.preventDefault();
				storageSet('log', null);
				notify(`${NAME}: licznik wyzerowany – uruchom skrypt ponownie.`, 'SuccessMessage');
				$('#' + NS).remove();
			});
		});
	}

	// ---------- Start ----------
	async function main() {
		if (typeof game_data === 'undefined') { notify(`${NAME}: uruchom skrypt w grze.`); return; }
		const url = location.href;
		const onCommands = /[?&]screen=overview_villages(&|$)/.test(url) && $('#commands_table').length > 0;
		if (!onCommands || !/[?&]page=-1(&|$)/.test(url)) {
			const t = game_data.player.sitter && Number(game_data.player.sitter) > 0 ? '&t=' + game_data.player.id : '';
			location.href = `/game.php?village=${game_data.village.id}${t}&screen=overview_villages&mode=commands&type=all&page=-1`;
			return;
		}
		const s = loadSettings();
		const now = serverNow();
		const speeds = await unitSpeeds();
		const fakes = readCommands(now).filter(c => isFake(c, s));
		const log = loadLog(now);
		const added = updateLog(log, fakes, speeds, now);
		storageSet('log', log);
		render(s, { now, fakes: fakes.length, returning: fakes.filter(c => c.type === 'return').length, days: countsByDay(log), log, added });
	}

	if (Date.now() - (window[NS + '_lastRun'] || 0) < 500) { return; } // gra potrafi wykonać skrót dwa razy naraz
	window[NS + '_lastRun'] = Date.now();
	main().catch(ex => {
		notify(NAME + ': ' + (typeof ex === 'string' ? ex : 'błąd – ' + (ex && ex.message ? ex.message : ex)), 'ErrorMessage');
		console.error(NAME, ex);
	});
})();
