// SPDX-License-Identifier: AGPL-3.0-or-later
// Compact common-password data for the password policy. Passwords shorter than 12 characters are already refused
// by the length rule, so this list targets what people type when forced to reach 12: a common base word or
// keyboard walk, repeated or followed by a common suffix. `isCommonPassword` expands the bases with the suffixes
// at check time (about 160 bases Ã— 60 suffixes â‰ˆ 10,000 candidates) instead of shipping the expanded list, and
// also matches a list of well-known long passwords literally. Comparison is case-insensitive.

/** Base words seen at the top of public breach-frequency lists (all lowercase, no digits). */
// biome-ignore format: compact data table
export const COMMON_BASES: readonly string[] = [
  "password", "passw0rd", "p@ssword", "p@ssw0rd", "qwerty", "qwertyuiop", "asdfghjkl", "zxcvbnm",
  "qwertyui", "azerty", "abc", "abcd", "abcdef", "abcdefg", "abcdefgh", "iloveyou", "letmein", "welcome",
  "admin", "administrator", "root", "user", "login", "master", "secret", "default", "changeme", "test",
  "testing", "guest", "access", "monkey", "dragon", "football", "baseball", "soccer", "hockey", "basketball",
  "superman", "batman", "spiderman", "pokemon", "starwars", "princess", "sunshine", "shadow", "michael",
  "jennifer", "jordan", "hunter", "ranger", "buster", "thomas", "robert", "daniel", "charlie", "andrew",
  "michelle", "jessica", "ashley", "nicole", "matthew", "joshua", "anthony", "william", "amanda", "maria",
  "jesus", "christ", "god", "love", "lovely", "loveme", "angel", "angels", "baby", "babygirl", "flower",
  "summer", "winter", "spring", "autumn", "freedom", "whatever", "trustno1", "computer", "internet",
  "samsung", "apple", "google", "microsoft", "windows", "linux", "android", "iphone", "facebook", "twitter",
  "instagram", "youtube", "minecraft", "fortnite", "killer", "pepper", "ginger", "cookie", "chocolate",
  "cheese", "banana", "orange", "purple", "silver", "golden", "diamond", "tigger", "tiger", "lion", "eagle",
  "falcon", "mustang", "ferrari", "porsche", "corvette", "harley", "yankees", "lakers", "chelsea",
  "liverpool", "arsenal", "barcelona", "madrid", "united", "america", "london", "paris", "berlin", "mexico",
  "brazil", "peru", "lima", "chile", "argentina", "colombia", "espana", "contrasena", "contrasenia", "clave",
  "hola", "teamo", "amor", "familia", "futbol", "senha", "motdepasse", "passwort", "hallo", "ciao", "amore",
  "pptaken", "presentation", "slides", "letmein", "football", "qazwsx", "qazwsxedc", "1qaz2wsx", "zaq12wsx",
];

/** Common suffixes appended to a base (and the empty suffix). */
// biome-ignore format: compact data table
export const COMMON_SUFFIXES: readonly string[] = [
  "", "1", "12", "123", "1234", "12345", "123456", "1234567", "12345678", "123456789", "1234567890", "0",
  "00", "000", "01", "007", "11", "111", "1111", "13", "21", "22", "23", "69", "77", "88", "99", "100",
  "321", "666", "777", "786", "2000", "2001", "2010", "2015", "2016", "2017", "2018", "2019", "2020",
  "2021", "2022", "2023", "2024", "2025", "2026", "2027", "!", "!!", "!!!", "1!", "12!", "123!", "1234!",
  "@", "@123", "#1", "$", ".", "*", "?", "_", "_1", "_123", "123.", "!@#", "!@#$",
];

/** Well-known long passwords and keyboard walks matched literally. */
// biome-ignore format: compact data table
export const COMMON_LONG: readonly string[] = [
  "123456789012", "1234567890123", "12345678901234", "123123123123", "121212121212", "111111111111",
  "000000000000", "112233445566", "123321123321", "987654321098", "098765432109", "147258369147",
  "123qweasdzxc", "1q2w3e4r5t6y", "1q2w3e4r5t6y7u", "q1w2e3r4t5y6", "qwertyuiopasdfghjkl",
  "qwertyuiop123", "qwertyuiop1234", "1qaz2wsx3edc", "1qaz2wsx3edc4rfv", "zaq1xsw2cde3", "zaq12wsxcde3",
  "qazwsxedcrfv", "qwerasdfzxcv", "asdfghjkl123", "asdfghjkl;'", "zxcvbnm12345", "abcdefghijkl",
  "abcdefghijklmnop", "abcdefghijklmnopqrstuvwxyz", "abcabcabcabc", "aaaaaaaaaaaa", "passwordpassword",
  "iloveyouiloveyou", "letmeinletmein", "welcomewelcome", "adminadminadmin", "correcthorsebatterystaple",
  "thequickbrownfox", "thequickbrownfoxjumpsoverthelazydog", "ihateyouihateyou", "mypasswordis",
  "myownpassword", "thisismypassword", "changemeplease", "pleaseletmein", "nopasswordhere",
  "passwordispassword", "superpassword", "supersecretpassword", "verysecretpassword", "mysecretpassword",
  "masterpassword", "defaultpassword", "temporarypassword", "newpassword123", "oldpassword123",
  "password1234567", "password12345678", "iloveyou12345", "football12345", "baseball12345",
  "trustno1trustno1", "starwars12345", "princess12345", "sunshine12345", "michael12345", "jennifer12345",
  "liverpool1892", "manchesterunited", "realmadrid123", "barcelona1899", "contrasena123", "contraseÃ±a123",
  "contraseÃ±a", "teamomucho", "teamomuchoamor", "holamundo123", "helloworld123", "helloworld1234",
];

let literal: Set<string> | undefined;

/** True when `password` (case-insensitive) is a known common password or a common base + suffix. */
export function isCommonPassword(password: string): boolean {
  const p = password.toLowerCase();
  literal ??= new Set(COMMON_LONG);
  if (literal.has(p)) return true;
  for (const base of COMMON_BASES) {
    if (!p.startsWith(base)) continue;
    const rest = p.slice(base.length);
    if (COMMON_SUFFIXES.includes(rest)) return true;
    // The base repeated (passwordpassword, qwertyqwerty123).
    if (rest.startsWith(base) && COMMON_SUFFIXES.includes(rest.slice(base.length))) return true;
  }
  return false;
}
