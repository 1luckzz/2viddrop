'use strict';

// Geolocalização de IP com o fetch substituído por um dublê.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { criarGeolocalizador, ehIpLocal } = require('../auth/geo');

function dublê(respostas) {
  const chamadas = [];
  const buscar = async (url) => {
    chamadas.push(url);
    const r = respostas.shift();
    if (r instanceof Error) throw r;
    return { ok: r.ok !== false, json: async () => r.corpo };
  };
  return { buscar, chamadas };
}

describe('ehIpLocal', () => {
  test('reconhece loopback e redes privadas', () => {
    for (const ip of ['::1', '127.0.0.1', '::ffff:127.0.0.1', '10.0.0.5', '192.168.1.10', '172.16.0.1', '172.31.255.1', 'fc00::1', 'fe80::1']) {
      assert.strictEqual(ehIpLocal(ip), true, ip);
    }
    for (const ip of ['177.45.12.9', '172.70.239.144', '2804:14d:1::7a', '8.8.8.8']) {
      assert.strictEqual(ehIpLocal(ip), false, ip);
    }
  });
});

describe('localizar', () => {
  test('monta "Cidade, Estado · País" a partir da resposta', async () => {
    const { buscar, chamadas } = dublê([{ corpo: { status: 'success', country: 'Brasil', regionName: 'Paraná', city: 'Curitiba' } }]);
    const geo = criarGeolocalizador({ buscar });
    assert.strictEqual(await geo.localizar('177.45.12.9'), 'Curitiba, Paraná · Brasil');
    assert.match(chamadas[0], /^http:\/\/ip-api\.com\/json\/177\.45\.12\.9\?/);
    assert.match(chamadas[0], /lang=pt-BR/);
  });

  test('cache: o mesmo IP não consulta duas vezes', async () => {
    const { buscar, chamadas } = dublê([{ corpo: { status: 'success', country: 'Brasil', regionName: 'São Paulo', city: 'São Paulo' } }]);
    const geo = criarGeolocalizador({ buscar });
    await geo.localizar('201.17.88.201');
    await geo.localizar('201.17.88.201');
    assert.strictEqual(chamadas.length, 1);
  });

  test('IP local não consulta e devolve "local"', async () => {
    const { buscar, chamadas } = dublê([]);
    const geo = criarGeolocalizador({ buscar });
    assert.strictEqual(await geo.localizar('::1'), 'local');
    assert.strictEqual(await geo.localizar('192.168.0.3'), 'local');
    assert.strictEqual(chamadas.length, 0);
  });

  test('sem IP, falha de rede, resposta não-ok ou status fail devolvem null, sem lançar', async () => {
    const { buscar } = dublê([new Error('rede'), { ok: false, corpo: {} }, { corpo: { status: 'fail', message: 'private range' } }]);
    const geo = criarGeolocalizador({ buscar });
    assert.strictEqual(await geo.localizar(null), null);
    assert.strictEqual(await geo.localizar('1.1.1.1'), null, 'falha de rede');
    assert.strictEqual(await geo.localizar('1.1.1.2'), null, 'resposta não-ok');
    assert.strictEqual(await geo.localizar('1.1.1.3'), null, 'status fail');
  });

  test('campos vazios são omitidos', async () => {
    const { buscar } = dublê([{ corpo: { status: 'success', country: 'Brasil', regionName: '', city: '' } }]);
    const geo = criarGeolocalizador({ buscar });
    assert.strictEqual(await geo.localizar('1.1.1.4'), 'Brasil');
  });
});
