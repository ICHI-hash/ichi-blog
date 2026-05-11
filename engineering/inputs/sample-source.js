/**
 * ユークリッドの互除法で最大公約数を返す。
 * @param {number} a - 整数
 * @param {number} b - 整数
 * @returns {number} 非負の最大公約数
 * @throws {TypeError} 引数が整数でない場合
 */
export function gcd(a, b) {
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    throw new TypeError('Arguments must be integers');
  }
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a;
}

/**
 * メールアドレスの簡易バリデーション。
 * ローカル部 + @ + ドメイン + . + TLD の形式を検査する。
 * @param {string} email
 * @returns {boolean}
 */
export function isEmail(email) {
  if (typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * 文字列を指定した区切り文字でトークンに分割し、空文字列を除去して返す。
 * @param {string} str - 対象文字列
 * @param {string} [sep=','] - 区切り文字
 * @returns {string[]}
 */
export function tokenize(str, sep = ',') {
  if (typeof str !== 'string') throw new TypeError('str must be a string');
  return str.split(sep).map(t => t.trim()).filter(t => t.length > 0);
}
