// Standalone self-test for the minimal JSON module in main.cpp.
// Build & run:  g++ -std=c++20 -O1 -o /tmp/mjtest worker/src/mj_selftest.cpp && /tmp/mjtest
// This file is NOT part of the cmake target; it exists so the parser can be
// verified without the Discord Social SDK present.

#include <cassert>
#include <cmath>
#include <iostream>
#include <string>

// --- begin copy of mj from main.cpp (keep in sync) ---
#include <cstdio>
#include <sstream>
#include <stdexcept>
#include <utility>
#include <vector>
namespace mj {

struct Value {
  enum class T { Null, Bool, Num, Str, Arr, Obj };
  T t = T::Null;
  bool b = false;
  double num = 0;
  std::string str;
  std::vector<Value> arr;
  std::vector<std::pair<std::string, Value>> obj;

  const Value* find(const std::string& key) const {
    if (t != T::Obj) return nullptr;
    for (const auto& [k, v] : obj) {
      if (k == key) return &v;
    }
    return nullptr;
  }
  bool isStr() const { return t == T::Str; }
  int64_t asInt(int64_t fallback = 0) const {
    return t == T::Num ? static_cast<int64_t>(num) : fallback;
  }
  std::string asStr(const std::string& fallback = "") const {
    return t == T::Str ? str : fallback;
  }
};

class Parser {
 public:
  explicit Parser(const std::string& text) : s_(text) {}

  Value parse() {
    skipWs();
    Value v = parseValue();
    skipWs();
    if (pos_ != s_.size()) fail("trailing characters");
    return v;
  }

 private:
  const std::string& s_;
  size_t pos_ = 0;

  [[noreturn]] void fail(const char* what) const {
    throw std::runtime_error(std::string("json: ") + what + " at offset " +
                             std::to_string(pos_));
  }

  void skipWs() {
    while (pos_ < s_.size() &&
           (s_[pos_] == ' ' || s_[pos_] == '\t' || s_[pos_] == '\n' || s_[pos_] == '\r')) {
      ++pos_;
    }
  }

  char peek() {
    if (pos_ >= s_.size()) fail("unexpected end of input");
    return s_[pos_];
  }

  void expect(char c) {
    if (peek() != c) fail("unexpected character");
    ++pos_;
  }

  bool literal(const char* word) {
    const size_t len = std::char_traits<char>::length(word);
    if (s_.compare(pos_, len, word) == 0) {
      pos_ += len;
      return true;
    }
    return false;
  }

  Value parseValue() {
    const char c = peek();
    switch (c) {
      case '{': return parseObject();
      case '[': return parseArray();
      case '"': {
        Value v;
        v.t = Value::T::Str;
        v.str = parseString();
        return v;
      }
      case 't':
        if (!literal("true")) fail("bad literal");
        return Value{.t = Value::T::Bool, .b = true};
      case 'f':
        if (!literal("false")) fail("bad literal");
        return Value{.t = Value::T::Bool, .b = false};
      case 'n':
        if (!literal("null")) fail("bad literal");
        return Value{};
      default: return parseNumber();
    }
  }

  Value parseObject() {
    expect('{');
    Value v;
    v.t = Value::T::Obj;
    skipWs();
    if (peek() == '}') {
      ++pos_;
      return v;
    }
    for (;;) {
      skipWs();
      std::string key = parseString();
      skipWs();
      expect(':');
      skipWs();
      v.obj.emplace_back(std::move(key), parseValue());
      skipWs();
      const char c = peek();
      if (c == ',') {
        ++pos_;
        continue;
      }
      if (c == '}') {
        ++pos_;
        return v;
      }
      fail("expected ',' or '}'");
    }
  }

  Value parseArray() {
    expect('[');
    Value v;
    v.t = Value::T::Arr;
    skipWs();
    if (peek() == ']') {
      ++pos_;
      return v;
    }
    for (;;) {
      skipWs();
      v.arr.push_back(parseValue());
      skipWs();
      const char c = peek();
      if (c == ',') {
        ++pos_;
        continue;
      }
      if (c == ']') {
        ++pos_;
        return v;
      }
      fail("expected ',' or ']'");
    }
  }

  std::string parseString() {
    expect('"');
    std::string out;
    while (pos_ < s_.size()) {
      const char c = s_[pos_++];
      if (c == '"') return out;
      if (c != '\\') {
        out.push_back(c);
        continue;
      }
      if (pos_ >= s_.size()) fail("bad escape");
      const char esc = s_[pos_++];
      switch (esc) {
        case '"': out.push_back('"'); break;
        case '\\': out.push_back('\\'); break;
        case '/': out.push_back('/'); break;
        case 'b': out.push_back('\b'); break;
        case 'f': out.push_back('\f'); break;
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        case 'u': {
          unsigned cp = parseHex4();
          if (cp >= 0xD800 && cp <= 0xDBFF && pos_ + 1 < s_.size() &&
              s_[pos_] == '\\' && s_[pos_ + 1] == 'u') {
            pos_ += 2;
            const unsigned low = parseHex4();
            if (low >= 0xDC00 && low <= 0xDFFF) {
              cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
            }
          }
          appendUtf8(out, cp);
          break;
        }
        default: fail("bad escape character");
      }
    }
    fail("unterminated string");
  }

  unsigned parseHex4() {
    if (pos_ + 4 > s_.size()) fail("bad \\u escape");
    unsigned value = 0;
    for (int i = 0; i < 4; ++i) {
      const char c = s_[pos_++];
      value <<= 4;
      if (c >= '0' && c <= '9') value |= static_cast<unsigned>(c - '0');
      else if (c >= 'a' && c <= 'f') value |= static_cast<unsigned>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') value |= static_cast<unsigned>(c - 'A' + 10);
      else fail("bad hex digit");
    }
    return value;
  }

  static void appendUtf8(std::string& out, unsigned cp) {
    if (cp < 0x80) {
      out.push_back(static_cast<char>(cp));
    } else if (cp < 0x800) {
      out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
      out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
      out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
  }

  Value parseNumber() {
    const size_t start = pos_;
    if (peek() == '-') ++pos_;
    bool digits = false;
    while (pos_ < s_.size()) {
      const char c = s_[pos_];
      if (c >= '0' && c <= '9') {
        digits = true;
        ++pos_;
      } else if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
        ++pos_;
      } else {
        break;
      }
    }
    if (!digits) fail("bad number");
    Value v;
    v.t = Value::T::Num;
    v.num = std::stod(s_.substr(start, pos_ - start));
    return v;
  }
};

inline Value parse(const std::string& text) { return Parser(text).parse(); }

inline std::string escape(const std::string& in) {
  std::string out;
  out.reserve(in.size() + 8);
  for (const unsigned char c : in) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  return out;
}

}  // namespace mj
// --- end copy of mj ---

// Round-trip helper mirroring Worker::serialize in main.cpp (kept in sync).
std::string serialize(const mj::Value& v) {
  switch (v.t) {
    case mj::Value::T::Null: return "null";
    case mj::Value::T::Bool: return v.b ? "true" : "false";
    case mj::Value::T::Num: {
      std::ostringstream out;
      out << v.num;
      return out.str();
    }
    case mj::Value::T::Str: return "\"" + mj::escape(v.str) + "\"";
    case mj::Value::T::Arr: {
      std::string out = "[";
      for (size_t i = 0; i < v.arr.size(); ++i) {
        if (i) out += ",";
        out += serialize(v.arr[i]);
      }
      return out + "]";
    }
    case mj::Value::T::Obj: {
      std::string out = "{";
      for (size_t i = 0; i < v.obj.size(); ++i) {
        if (i) out += ",";
        out += "\"" + mj::escape(v.obj[i].first) + "\":" + serialize(v.obj[i].second);
      }
      return out + "}";
    }
  }
  return "null";
}

int main() {
  // 1. Parse a realistic poll payload.
  const std::string payload = R"({
    "sessions": [
      {
        "discord_user_id": "123456789012345678",
        "desired_state": "running",
        "revision": 7,
        "activity": {
          "type": 2,
          "details": "🎵 Listening to Music \"on repeat\"",
          "state": "Café del Mar\tvol. 2",
          "timestamps": { "start": 1758000000000, "end": 1758003600000 },
          "assets": { "large_image": "https://example.com/a.png", "large_text": "Now playing" },
          "party": { "size": [3, 5] }
        },
        "access_token": "tok en-with-\\backslash"
      },
      { "discord_user_id": "42", "desired_state": "stopped", "revision": 3, "activity": null }
    ],
    "server_time": "2026-09-20T00:00:00.000Z"
  })";
  mj::Value doc = mj::parse(payload);
  assert(doc.find("sessions") && doc.find("sessions")->arr.size() == 2);
  const mj::Value& s0 = doc.find("sessions")->arr[0];
  assert(s0.find("discord_user_id")->str == "123456789012345678");
  assert(s0.find("revision")->asInt() == 7);
  const mj::Value& act = *s0.find("activity");
  assert(act.find("type")->asInt() == 2);
  assert(act.find("details")->str == "🎵 Listening to Music \"on repeat\"");
  assert(act.find("state")->str == "Café del Mar\tvol. 2");
  const mj::Value& ts = *act.find("timestamps");
  assert(ts.find("start")->asInt() == 1758000000000LL);
  assert(ts.find("end")->asInt() == 1758003600000LL);
  const mj::Value& party = *act.find("party");
  assert(party.find("size")->arr[0].asInt() == 3 && party.find("size")->arr[1].asInt() == 5);
  assert(s0.find("access_token")->str == "tok en-with-\\backslash");
  const mj::Value& s1 = doc.find("sessions")->arr[1];
  assert(s1.find("activity")->t == mj::Value::T::Null);
  assert(doc.find("server_time")->str == "2026-09-20T00:00:00.000Z");

  // 2. Escapes and unicode.
  assert(mj::parse("\"\\u00e9\\ud83d\\ude00\"").str == "é😀");
  assert(mj::escape(std::string("a\"b\\c\nd\te")) == "a\\\"b\\\\c\\nd\\te");

  // 3. Serialize round-trip is stable.
  const std::string canon = serialize(doc);
  mj::Value again = mj::parse(canon);
  assert(serialize(again) == canon);

  // 4. Malformed inputs throw instead of crashing.
  for (const char* bad : {"", "{", "{\"a\":}", "[1,]", "nul", "\"abc", "{\"a\":1}x", "-"}) {
    bool threw = false;
    try {
      mj::parse(bad);
    } catch (const std::exception&) {
      threw = true;
    }
    assert(threw);
  }

  // 5. find() on non-objects is safe.
  assert(mj::parse("42").find("x") == nullptr);

  std::cout << "all mj self-tests passed" << std::endl;
  return 0;
}
