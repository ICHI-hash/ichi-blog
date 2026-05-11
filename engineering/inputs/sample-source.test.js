import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gcd, isEmail, tokenize } from './sample-source.js';

// ─────────────────────────────────────────────
// gcd
// ─────────────────────────────────────────────
describe('gcd', () => {
  // 正常系
  test('正の整数同士 - 基本ケース', () => {
    assert.equal(gcd(12, 8), 4);
  });

  test('正の整数同士 - 互いに素', () => {
    assert.equal(gcd(7, 13), 1);
  });

  test('正の整数同士 - 一方が他方の倍数', () => {
    assert.equal(gcd(9, 3), 3);
  });

  test('同じ値同士', () => {
    assert.equal(gcd(6, 6), 6);
  });

  test('a が 0 の場合は b を返す', () => {
    assert.equal(gcd(0, 5), 5);
  });

  test('b が 0 の場合は a を返す', () => {
    assert.equal(gcd(5, 0), 5);
  });

  test('両方 0 の場合は 0 を返す', () => {
    assert.equal(gcd(0, 0), 0);
  });

  test('負の整数 a - 絶対値で計算する', () => {
    assert.equal(gcd(-12, 8), 4);
  });

  test('負の整数 b - 絶対値で計算する', () => {
    assert.equal(gcd(12, -8), 4);
  });

  test('両方負の整数', () => {
    assert.equal(gcd(-12, -8), 4);
  });

  test('大きな値', () => {
    assert.equal(gcd(1000000, 500000), 500000);
  });

  test('連続する整数は互いに素', () => {
    assert.equal(gcd(100, 101), 1);
  });

  test('1 との GCD は常に 1', () => {
    assert.equal(gcd(1, 999), 1);
    assert.equal(gcd(999, 1), 1);
  });

  // 異常系
  test('浮動小数点数を渡すと TypeError', () => {
    assert.throws(() => gcd(1.5, 2), TypeError);
  });

  test('b が浮動小数点数を渡すと TypeError', () => {
    assert.throws(() => gcd(2, 1.5), TypeError);
  });

  test('両方浮動小数点数を渡すと TypeError', () => {
    assert.throws(() => gcd(1.1, 2.2), TypeError);
  });

  test('文字列を渡すと TypeError', () => {
    assert.throws(() => gcd('12', 8), TypeError);
  });

  test('null を渡すと TypeError', () => {
    assert.throws(() => gcd(null, 8), TypeError);
  });

  test('undefined を渡すと TypeError', () => {
    assert.throws(() => gcd(undefined, 8), TypeError);
  });

  test('NaN を渡すと TypeError', () => {
    assert.throws(() => gcd(NaN, 8), TypeError);
  });

  test('Infinity を渡すと TypeError', () => {
    assert.throws(() => gcd(Infinity, 8), TypeError);
  });

  test('TypeError メッセージが正しい', () => {
    assert.throws(
      () => gcd(1.5, 2),
      (err) => {
        assert.ok(err instanceof TypeError);
        assert.equal(err.message, 'Arguments must be integers');
        return true;
      }
    );
  });

  // 境界値
  test('Number.MAX_SAFE_INTEGER と自身', () => {
    assert.equal(gcd(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  });

  test('1 と 1', () => {
    assert.equal(gcd(1, 1), 1);
  });
});

// ─────────────────────────────────────────────
// isEmail
// ─────────────────────────────────────────────
describe('isEmail', () => {
  // 正常系 - 有効
  test('標準的なメールアドレス', () => {
    assert.equal(isEmail('user@example.com'), true);
  });

  test('サブドメイン付き', () => {
    assert.equal(isEmail('user@mail.example.com'), true);
  });

  test('ハイフン含むドメイン', () => {
    assert.equal(isEmail('user@my-domain.org'), true);
  });

  test('数字を含むローカル部', () => {
    assert.equal(isEmail('user123@example.co.jp'), true);
  });

  test('ローカル部にドットを含む', () => {
    assert.equal(isEmail('first.last@example.com'), true);
  });

  test('ローカル部にプラスを含む', () => {
    assert.equal(isEmail('user+tag@example.com'), true);
  });

  test('前後の空白はトリムして有効', () => {
    assert.equal(isEmail('  user@example.com  '), true);
  });

  test('大文字を含むアドレス', () => {
    assert.equal(isEmail('User@Example.COM'), true);
  });

  // 正常系 - 無効
  test('@ がない', () => {
    assert.equal(isEmail('userexample.com'), false);
  });

  test('@ が複数', () => {
    assert.equal(isEmail('user@@example.com'), false);
  });

  test('ドメインにドットがない', () => {
    assert.equal(isEmail('user@examplecom'), false);
  });

  test('空文字列', () => {
    assert.equal(isEmail(''), false);
  });

  test('空白のみ', () => {
    assert.equal(isEmail('   '), false);
  });

  test('ローカル部が空', () => {
    assert.equal(isEmail('@example.com'), false);
  });

  test('ドメイン部が空', () => {
    assert.equal(isEmail('user@'), false);
  });

  test('スペースを含む（トリム後も残る）', () => {
    assert.equal(isEmail('us er@example.com'), false);
  });

  test('@ の前後にスペース', () => {
    assert.equal(isEmail('user @example.com'), false);
  });

  // 異常系 - 型
  test('数値を渡すと false', () => {
    assert.equal(isEmail(123), false);
  });

  test('null を渡すと false', () => {
    assert.equal(isEmail(null), false);
  });

  test('undefined を渡すと false', () => {
    assert.equal(isEmail(undefined), false);
  });

  test('オブジェクトを渡すと false', () => {
    assert.equal(isEmail({}), false);
  });

  test('配列を渡すと false', () => {
    assert.equal(isEmail(['user@example.com']), false);
  });

  test('boolean を渡すと false', () => {
    assert.equal(isEmail(true), false);
  });

  // 境界値
  test('TLD が 1 文字', () => {
    // ドットの後に少なくとも1文字あれば正規表現は通る
    assert.equal(isEmail('user@example.c'), true);
  });

  test('非常に長いローカル部', () => {
    const local = 'a'.repeat(64);
    assert.equal(isEmail(`${local}@example.com`), true);
  });
});

// ─────────────────────────────────────────────
// tokenize
// ─────────────────────────────────────────────
describe('tokenize', () => {
  // 正常系
  test('カンマ区切りの基本ケース', () => {
    assert.deepEqual(tokenize('a,b,c'), ['a', 'b', 'c']);
  });

  test('各トークンの前後空白をトリムする', () => {
    assert.deepEqual(tokenize(' a , b , c '), ['a', 'b', 'c']);
  });

  test('空文字列トークンを除去する', () => {
    assert.deepEqual(tokenize('a,,b'), ['a', 'b']);
  });

  test('区切り文字を明示的に指定', () => {
    assert.deepEqual(tokenize('a|b|c', '|'), ['a', 'b', 'c']);
  });

  test('区切り文字にスペースを指定', () => {
    assert.deepEqual(tokenize('hello world foo', ' '), ['hello', 'world', 'foo']);
  });

  test('区切り文字に複数文字を指定', () => {
    assert.deepEqual(tokenize('a::b::c', '::'), ['a', 'b', 'c']);
  });

  test('トークンが 1 つだけ', () => {
    assert.deepEqual(tokenize('hello'), ['hello']);
  });

  test('全体が空白のみ → 空配列', () => {
    assert.deepEqual(tokenize('   '), []);
  });

  test('空文字列 → 空配列', () => {
    assert.deepEqual(tokenize(''), []);
  });

  test('区切り文字のみ → 空配列', () => {
    assert.deepEqual(tokenize(',,,'), []);
  });

  test('先頭・末尾に区切り文字', () => {
    assert.deepEqual(tokenize(',a,b,'), ['a', 'b']);
  });

  test('sep のデフォルトはカンマ', () => {
    assert.deepEqual(tokenize('x,y'), ['x', 'y']);
  });

  test('数字文字列を含む', () => {
    assert.deepEqual(tokenize('1,2,3'), ['1', '2', '3']);
  });

  test('Unicode 文字列', () => {
    assert.deepEqual(tokenize('あ,い,う'), ['あ', 'い', 'う']);
  });

  // 異常系
  test('str が数値だと TypeError', () => {
    assert.throws(() => tokenize(123), TypeError);
  });

  test('str が null だと TypeError', () => {
    assert.throws(() => tokenize(null), TypeError);
  });

  test('str が undefined だと TypeError', () => {
    assert.throws(() => tokenize(undefined), TypeError);
  });

  test('str が配列だと TypeError', () => {
    assert.throws(() => tokenize(['a', 'b']), TypeError);
  });

  test('str がオブジェクトだと TypeError', () => {
    assert.throws(() => tokenize({}), TypeError);
  });

  test('TypeError のメッセージが正しい', () => {
    assert.throws(
      () => tokenize(42),
      (err) => {
        assert.ok(err instanceof TypeError);
        assert.equal(err.message, 'str must be a string');
        return true;
      }
    );
  });

  // 境界値
  test('sep に空文字列を渡すと 1 文字ずつに分割', () => {
    assert.deepEqual(tokenize('abc', ''), ['a', 'b', 'c']);
  });

  test('sep が str 内に存在しない場合はそのまま 1 要素', () => {
    assert.deepEqual(tokenize('hello', '|'), ['hello']);
  });

  test('非常に長い文字列', () => {
    const big = Array.from({ length: 1000 }, (_, i) => `item${i}`).join(',');
    const result = tokenize(big);
    assert.equal(result.length, 1000);
    assert.equal(result[0], 'item0');
    assert.equal(result[999], 'item999');
  });

  test('トークンがスペースのみ → 除去される', () => {
    assert.deepEqual(tokenize('a,   ,b'), ['a', 'b']);
  });
});
