(scope => {

	'use strict';

	const settings = (() => {
		let object = JSON.parse(localStorage.getItem('config') || '{"hd": 1}');
		return object;
	})();

	// =========================================================================
	// Perfis de qualidade gráfica (substituem o antigo Q1..Q8)
	// =========================================================================
	settings.hdOptions = [
		{ id: 0, label: 'Baixa', ss: 1, desc: 'Mais fluido' },
		{ id: 1, label: 'Média', ss: 2, desc: 'Equilibrado' },
		{ id: 2, label: 'Alta',  ss: 3, desc: 'Mais nítido' },
	];

	// Migração: quem tinha o antigo `quality` cai no perfil Média
	if (settings.hd === undefined || settings.hd < 0 || settings.hd > 2) {
		settings.hd = 1;
	}

	settings.getSS = function () {
		return settings.hdOptions[settings.hd].ss;
	};

	settings.setHD = function (id) {
		if (id === settings.hd) return;
		settings.hd = id;
		localStorage.setItem('config', JSON.stringify(settings));
	};

	// Compatibilidade: se algum código antigo ainda chama updateQuality,
	// ele apenas cicla entre os 3 perfis. Só é usado pelo #quality legado.
	settings.updateQuality = function (update) {
		const elem = document.getElementById('quality');
		if (!elem) return;
		if (update) {
			settings.hd = (settings.hd + 1) % settings.hdOptions.length;
			localStorage.setItem('config', JSON.stringify(settings));
			elem.classList.add('restart');
		}
		elem.innerText = settings.hdOptions[settings.hd].label.charAt(0);
	};

	scope.settings = settings;

})(window);