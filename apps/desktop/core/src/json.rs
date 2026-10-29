//! A small strict JSON reader and string quoting: the supervised line, `launch.json` and `desktop.json` are the only
//! JSON the shell reads, all short. Duplicate keys, trailing text and nesting deeper than `MAX_DEPTH` are refused.

/// Deepest nesting accepted.
pub const MAX_DEPTH: usize = 16;
/// Longest text accepted (bytes).
pub const MAX_LEN: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    /// The value of `key` in an object.
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(b) => Some(*b),
            _ => None,
        }
    }
    /// A whole number in `0..=max`.
    pub fn as_uint(&self, max: u64) -> Option<u64> {
        match self {
            Json::Num(n) if n.fract() == 0.0 && *n >= 0.0 && *n <= max as f64 => Some(*n as u64),
            _ => None,
        }
    }
}

struct Reader<'a> {
    s: &'a [u8],
    i: usize,
}

pub fn parse(text: &str) -> Result<Json, String> {
    if text.len() > MAX_LEN {
        return Err(format!("longer than {MAX_LEN} bytes"));
    }
    let mut r = Reader { s: text.as_bytes(), i: 0 };
    r.ws();
    let v = r.value(0)?;
    r.ws();
    if r.i != r.s.len() {
        return Err(format!("unexpected text at byte {}", r.i));
    }
    Ok(v)
}

impl Reader<'_> {
    fn ws(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }
    fn lit(&mut self, word: &str, v: Json) -> Result<Json, String> {
        if self.s[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Ok(v)
        } else {
            Err(format!("unexpected text at byte {}", self.i))
        }
    }
    fn value(&mut self, depth: usize) -> Result<Json, String> {
        if depth > MAX_DEPTH {
            return Err("nested too deep".into());
        }
        match self.peek() {
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => self.string().map(Json::Str),
            Some(b't') => self.lit("true", Json::Bool(true)),
            Some(b'f') => self.lit("false", Json::Bool(false)),
            Some(b'n') => self.lit("null", Json::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(format!("unexpected text at byte {}", self.i)),
        }
    }
    fn object(&mut self, depth: usize) -> Result<Json, String> {
        self.i += 1;
        let mut fields: Vec<(String, Json)> = Vec::new();
        self.ws();
        if self.peek() == Some(b'}') {
            self.i += 1;
            return Ok(Json::Obj(fields));
        }
        loop {
            self.ws();
            if self.peek() != Some(b'"') {
                return Err(format!("a key expected at byte {}", self.i));
            }
            let k = self.string()?;
            if fields.iter().any(|(x, _)| *x == k) {
                return Err(format!("duplicate key {k:?}"));
            }
            self.ws();
            if self.peek() != Some(b':') {
                return Err(format!("':' expected at byte {}", self.i));
            }
            self.i += 1;
            self.ws();
            let v = self.value(depth + 1)?;
            fields.push((k, v));
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(Json::Obj(fields));
                }
                _ => return Err(format!("',' or '}}' expected at byte {}", self.i)),
            }
        }
    }
    fn array(&mut self, depth: usize) -> Result<Json, String> {
        self.i += 1;
        let mut items = Vec::new();
        self.ws();
        if self.peek() == Some(b']') {
            self.i += 1;
            return Ok(Json::Arr(items));
        }
        loop {
            self.ws();
            items.push(self.value(depth + 1)?);
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(Json::Arr(items));
                }
                _ => return Err(format!("',' or ']' expected at byte {}", self.i)),
            }
        }
    }
    fn hex4(&mut self) -> Result<u32, String> {
        let h = self.s.get(self.i..self.i + 4).ok_or("short \\u escape")?;
        let h = std::str::from_utf8(h).map_err(|_| "bad \\u escape")?;
        let v = u32::from_str_radix(h, 16).map_err(|_| "bad \\u escape")?;
        self.i += 4;
        Ok(v)
    }
    fn string(&mut self) -> Result<String, String> {
        self.i += 1;
        let mut out = String::new();
        loop {
            let start = self.i;
            while self.i < self.s.len() && self.s[self.i] != b'"' && self.s[self.i] != b'\\' && self.s[self.i] >= 0x20 {
                self.i += 1;
            }
            // The input is a &str: any run that stops at an ASCII byte is valid UTF-8.
            out.push_str(std::str::from_utf8(&self.s[start..self.i]).map_err(|_| "bad UTF-8")?);
            match self.peek() {
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.i += 1;
                    let c = self.peek().ok_or("unterminated string")?;
                    self.i += 1;
                    match c {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let code = if (0xD800..0xDC00).contains(&hi) {
                                if self.s.get(self.i..self.i + 2) != Some(b"\\u") {
                                    return Err("lone surrogate".into());
                                }
                                self.i += 2;
                                let lo = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&lo) {
                                    return Err("lone surrogate".into());
                                }
                                0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                            } else {
                                hi
                            };
                            out.push(char::from_u32(code).ok_or("lone surrogate")?);
                        }
                        _ => return Err(format!("bad escape at byte {}", self.i - 1)),
                    }
                }
                Some(_) => return Err(format!("control character in a string at byte {}", self.i)),
                None => return Err("unterminated string".into()),
            }
        }
    }
    fn number(&mut self) -> Result<Json, String> {
        let start = self.i;
        while self.i < self.s.len() && matches!(self.s[self.i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
            self.i += 1;
        }
        let t = std::str::from_utf8(&self.s[start..self.i]).map_err(|_| "bad number")?;
        let digits = t.strip_prefix('-').unwrap_or(t);
        if digits.is_empty() || !digits.as_bytes()[0].is_ascii_digit() || (digits.len() > 1 && digits.starts_with('0') && digits.as_bytes()[1].is_ascii_digit()) {
            return Err(format!("bad number at byte {start}"));
        }
        t.parse::<f64>().map(Json::Num).map_err(|_| format!("bad number at byte {start}"))
    }
}

/// `s` as a JSON string literal.
pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c == '\u{2028}' || c == '\u{2029}' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_shapes_it_reads() {
        let v = parse(r#" {"type":"ui","v":1,"port":4100,"reused":false,"a":[1,null,"xé\u00e9\ud83d\ude00"],"n":-1.5e2} "#).unwrap();
        assert_eq!(v.get("type").and_then(Json::as_str), Some("ui"));
        assert_eq!(v.get("v").and_then(|x| x.as_uint(10)), Some(1));
        assert_eq!(v.get("port").and_then(|x| x.as_uint(65535)), Some(4100));
        assert_eq!(v.get("reused").and_then(Json::as_bool), Some(false));
        assert_eq!(v.get("a"), Some(&Json::Arr(vec![Json::Num(1.0), Json::Null, Json::Str("xéé😀".into())])));
        assert_eq!(v.get("n"), Some(&Json::Num(-150.0)));
        assert_eq!(Json::Num(1.5).as_uint(10), None);
        assert_eq!(Json::Num(-1.0).as_uint(10), None);
    }

    #[test]
    fn refuses_what_is_not_strict_json() {
        for bad in [
            "",
            "{",
            "{\"a\":1,}",
            "{\"a\":1}x",
            "{\"a\":1,\"a\":2}",
            "{a:1}",
            "[01]",
            "\"\\x\"",
            "\"a\nb\"",
            "\"\\ud800\"",
            "'a'",
            "nul",
            "[1 2]",
        ] {
            assert!(parse(bad).is_err(), "{bad:?} parsed");
        }
        let deep = "[".repeat(MAX_DEPTH + 2) + &"]".repeat(MAX_DEPTH + 2);
        assert!(parse(&deep).is_err());
        assert!(parse(&" ".repeat(MAX_LEN + 1)).is_err());
    }

    #[test]
    fn quote_round_trips() {
        for s in ["", "plain", "a\"b\\c", "line\nnext\ttab\u{1}", "é😀", "/Users/x/My Workspace"] {
            assert_eq!(parse(&quote(s)).unwrap(), Json::Str(s.into()));
        }
    }
}
