const seedRandom = require('seed-random')

export default (prefix, seed, length = 32, secondsPrecision = 60, offset = 0) => {
  seed = prefix + seed + ((Math.round((+new Date() / 1000 / secondsPrecision)) * secondsPrecision) - (offset * secondsPrecision))
  var charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  var result = [];
  var rnd = seedRandom(seed);

  for(var i = 0; i < length; i++) {
    var num = Math.round(rnd() * charset.length)
    result.push(charset[num % charset.length])
  }

  return result.join("")
};
