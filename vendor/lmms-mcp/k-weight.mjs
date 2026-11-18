// ITU-R BS.1770 K-weighting, with coefficients derived for the file's sample rate.
export function kWeight(input, sampleRate) {
  const stage = (b, a, x) => {
    const y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  };
  let k = Math.tan(Math.PI * 1681.974450955533 / sampleRate);
  let q = 0.7071752369554196;
  const vh = 10 ** (3.999843853973347 / 20), vb = vh ** 0.4996667741545416;
  let a0 = 1 + k / q + k * k;
  const shelved = stage([(vh + vb * k / q + k * k) / a0, 2 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0],
    [2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0], input);
  k = Math.tan(Math.PI * 38.13547087602444 / sampleRate);
  q = 0.5003270373238773;
  a0 = 1 + k / q + k * k;
  return stage([1, -2, 1], [2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0], shelved);
}
