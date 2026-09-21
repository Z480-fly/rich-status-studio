// worker/src/main.cpp — Zora presence worker (Linux)
//
// The native half of the presence chain documented in README.md:
//
//   iPhone/browser → Zora API (this repo's web app) → this worker →
//   official Discord Social SDK → Discord Rich Presence
//
// Control-plane contract (worker/README.md):
//   GET  /api/public/worker/poll       Authorization: Bearer $WORKER_SHARED_SECRET
//   POST /api/public/worker/heartbeat  Authorization: Bearer $WORKER_SHARED_SECRET
//
// Per-user state machine (mirrors worker/harness/worker.mjs, which is covered
// by worker/harness/selftest.mjs):
//   - desired "running": apply the activity when the revision changed or the
//     last apply did not stick (error/cleared); otherwise heartbeat as running.
//   - desired "stopped": clear once if something was applied; never re-apply
//     until the server bumps the revision again.
//   - a heartbeat is sent every pass for every session so the phone sees
//     worker liveness, not just activity changes.
//
// Build modes (CMakeLists.txt):
//   - with the Social SDK unzipped into third_party/discord_social_sdk/:
//     real presence (see the adapter block below).
//   - without it: a dry-run binary that runs the identical loop and logs the
//     presence updates it would push — useful for testing against the live API.

#include <curl/curl.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <fstream>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#ifdef ZORA_HAVE_DISCORD_SDK
// discordpp.h is a generated single-header wrapper. Its implementation must be
// emitted in exactly one translation unit, as required by the SDK C++ guide.
#define DISCORDPP_IMPLEMENTATION
#include <discordpp.h>
#endif

namespace {

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

std::string isoNow() {
  std::time_t t = std::time(nullptr);
  std::tm tm{};
  gmtime_r(&t, &tm);
  char buf[32];
  std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tm);
  return buf;
}

void logLine(const std::string& msg) {
  std::cerr << "[" << isoNow() << "] " << msg << "\n";
}

std::string trim(const std::string& s) {
  size_t begin = 0;
  size_t end = s.size();
  while (begin < end && std::isspace((unsigned char)s[begin])) begin++;
  while (end > begin && std::isspace((unsigned char)s[end - 1])) end--;
  return s.substr(begin, end - begin);
}

// ---------------------------------------------------------------------------
// Minimal JSON (parse + serialize). Handles \uXXXX escapes incl. surrogate
// pairs, and serializes integral numbers without a decimal point so epoch
// millisecond timestamps survive a round-trip.
// ---------------------------------------------------------------------------

struct JValue {
  enum class Type { Null, Bool, Number, String, Array, Object };
  Type type = Type::Null;
  bool boolean = false;
  double number = 0.0;
  bool isInt = false;  // print without decimals when integral
  std::string string;
  std::vector<JValue> array;
  std::map<std::string, JValue> object;

  const JValue* find(const char* key) const {
    if (type != Type::Object) return nullptr;
    auto it = object.find(key);
    return it == object.end() ? nullptr : &it->second;
  }
};

void appendUtf8(std::string* out, unsigned int cp) {
  if (cp <= 0x7F) {
    out->push_back((char)cp);
  } else if (cp <= 0x7FF) {
    out->push_back((char)(0xC0 | (cp >> 6)));
    out->push_back((char)(0x80 | (cp & 0x3F)));
  } else if (cp <= 0xFFFF) {
    out->push_back((char)(0xE0 | (cp >> 12)));
    out->push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
    out->push_back((char)(0x80 | (cp & 0x3F)));
  } else {
    out->push_back((char)(0xF0 | (cp >> 18)));
    out->push_back((char)(0x80 | ((cp >> 12) & 0x3F)));
    out->push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
    out->push_back((char)(0x80 | (cp & 0x3F)));
  }
}

class JsonParser {
 public:
  explicit JsonParser(std::string_view text) : s_(text) {}

  bool parse(JValue* out, std::string* err) {
    skipWs();
    if (!parseValue(out, err, 0)) return false;
    skipWs();
    if (i_ != s_.size()) return fail(err, "trailing characters");
    return true;
  }

 private:
  std::string_view s_;
  size_t i_ = 0;

  bool fail(std::string* err, const std::string& msg) {
    *err = msg + " at offset " + std::to_string(i_);
    return false;
  }

  void skipWs() {
    while (i_ < s_.size() &&
           (s_[i_] == ' ' || s_[i_] == '\t' || s_[i_] == '\n' || s_[i_] == '\r')) {
      i_++;
    }
  }

  bool parseValue(JValue* out, std::string* err, int depth) {
    if (depth > 64) return fail(err, "JSON too deep");
    if (i_ >= s_.size()) return fail(err, "unexpected end of input");
    switch (s_[i_]) {
      case '{': return parseObject(out, err, depth);
      case '[': return parseArray(out, err, depth);
      case '"':
        out->type = JValue::Type::String;
        return parseString(&out->string, err);
      case 't': return parseLiteral(out, err, "true", JValue::Type::Bool, true);
      case 'f': return parseLiteral(out, err, "false", JValue::Type::Bool, false);
      case 'n': return parseLiteral(out, err, "null", JValue::Type::Null, false);
      default: return parseNumber(out, err);
    }
  }

  bool parseLiteral(JValue* out, std::string* err, const char* lit,
                    JValue::Type type, bool value) {
    size_t n = std::strlen(lit);
    if (s_.substr(i_, n) != lit) return fail(err, "invalid literal");
    i_ += n;
    out->type = type;
    out->boolean = value;
    return true;
  }

  bool parseObject(JValue* out, std::string* err, int depth) {
    out->type = JValue::Type::Object;
    i_++;  // '{'
    skipWs();
    if (i_ < s_.size() && s_[i_] == '}') {
      i_++;
      return true;
    }
    while (true) {
      skipWs();
      if (i_ >= s_.size() || s_[i_] != '"') return fail(err, "expected object key");
      std::string key;
      if (!parseString(&key, err)) return false;
      skipWs();
      if (i_ >= s_.size() || s_[i_] != ':') return fail(err, "expected ':'");
      i_++;
      skipWs();
      JValue value;
      if (!parseValue(&value, err, depth + 1)) return false;
      out->object[std::move(key)] = std::move(value);
      skipWs();
      if (i_ < s_.size() && s_[i_] == ',') {
        i_++;
        continue;
      }
      if (i_ < s_.size() && s_[i_] == '}') {
        i_++;
        return true;
      }
      return fail(err, "expected ',' or '}'");
    }
  }

  bool parseArray(JValue* out, std::string* err, int depth) {
    out->type = JValue::Type::Array;
    i_++;  // '['
    skipWs();
    if (i_ < s_.size() && s_[i_] == ']') {
      i_++;
      return true;
    }
    while (true) {
      skipWs();
      JValue value;
      if (!parseValue(&value, err, depth + 1)) return false;
      out->array.push_back(std::move(value));
      skipWs();
      if (i_ < s_.size() && s_[i_] == ',') {
        i_++;
        continue;
      }
      if (i_ < s_.size() && s_[i_] == ']') {
        i_++;
        return true;
      }
      return fail(err, "expected ',' or ']'");
    }
  }

  bool parseString(std::string* out, std::string* err) {
    i_++;  // opening quote
    out->clear();
    while (true) {
      if (i_ >= s_.size()) return fail(err, "unterminated string");
      unsigned char c = (unsigned char)s_[i_];
      if (c == '"') {
        i_++;
        return true;
      }
      if (c == '\\') {
        i_++;
        if (i_ >= s_.size()) return fail(err, "bad escape");
        char e = s_[i_++];
        switch (e) {
          case '"': out->push_back('"'); break;
          case '\\': out->push_back('\\'); break;
          case '/': out->push_back('/'); break;
          case 'b': out->push_back('\b'); break;
          case 'f': out->push_back('\f'); break;
          case 'n': out->push_back('\n'); break;
          case 'r': out->push_back('\r'); break;
          case 't': out->push_back('\t'); break;
          case 'u': {
            unsigned int cp = 0;
            if (!parseHex4(&cp, err)) return false;
            if (cp >= 0xD800 && cp <= 0xDBFF) {
              if (i_ + 1 < s_.size() && s_[i_] == '\\' && s_[i_ + 1] == 'u') {
                size_t save = i_;
                i_ += 2;
                unsigned int lo = 0;
                if (!parseHex4(&lo, err)) return false;
                if (lo >= 0xDC00 && lo <= 0xDFFF) {
                  cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                } else {
                  i_ = save;  // lone high surrogate
                  cp = 0xFFFD;
                }
              } else {
                cp = 0xFFFD;
              }
            } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
              cp = 0xFFFD;  // lone low surrogate
            }
            appendUtf8(out, cp);
            break;
          }
          default: return fail(err, "bad escape character");
        }
        continue;
      }
      if (c < 0x20) return fail(err, "control character in string");
      out->push_back((char)c);
      i_++;
    }
  }

  bool parseHex4(unsigned int* out, std::string* err) {
    if (i_ + 4 > s_.size()) return fail(err, "bad \\u escape");
    unsigned int v = 0;
    for (int k = 0; k < 4; k++) {
      char h = s_[i_++];
      v <<= 4;
      if (h >= '0' && h <= '9') {
        v |= (unsigned)(h - '0');
      } else if (h >= 'a' && h <= 'f') {
        v |= (unsigned)(h - 'a' + 10);
      } else if (h >= 'A' && h <= 'F') {
        v |= (unsigned)(h - 'A' + 10);
      } else {
        return fail(err, "bad \\u escape digit");
      }
    }
    *out = v;
    return true;
  }

  bool parseNumber(JValue* out, std::string* err) {
    size_t start = i_;
    while (i_ < s_.size() && s_[i_] != '\0' &&
           std::strchr("-+.eE0123456789", s_[i_]) != nullptr) {
      i_++;
    }
    if (i_ == start) return fail(err, "unexpected character");
    std::string num(s_.substr(start, i_ - start));
    out->type = JValue::Type::Number;
    out->number = std::strtod(num.c_str(), nullptr);
    out->isInt = num.find_first_of(".eE") == std::string::npos;
    return true;
  }
};

void dumpString(const std::string& v, std::string* out) {
  out->push_back('"');
  for (unsigned char c : v) {
    switch (c) {
      case '"': *out += "\\\""; break;
      case '\\': *out += "\\\\"; break;
      case '\b': *out += "\\b"; break;
      case '\f': *out += "\\f"; break;
      case '\n': *out += "\\n"; break;
      case '\r': *out += "\\r"; break;
      case '\t': *out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          *out += buf;
        } else {
          out->push_back((char)c);
        }
    }
  }
  out->push_back('"');
}

void dumpValue(const JValue& v, std::string* out) {
  switch (v.type) {
    case JValue::Type::Null: *out += "null"; break;
    case JValue::Type::Bool: *out += v.boolean ? "true" : "false"; break;
    case JValue::Type::Number:
      if (v.isInt) {
        *out += std::to_string((long long)std::llround(v.number));
      } else {
        char buf[40];
        std::snprintf(buf, sizeof(buf), "%.17g", v.number);
        *out += buf;
      }
      break;
    case JValue::Type::String: dumpString(v.string, out); break;
    case JValue::Type::Array: {
      *out += '[';
      bool first = true;
      for (const JValue& item : v.array) {
        if (!first) *out += ',';
        first = false;
        dumpValue(item, out);
      }
      *out += ']';
      break;
    }
    case JValue::Type::Object: {
      *out += '{';
      bool first = true;
      for (const auto& [key, value] : v.object) {
        if (!first) *out += ',';
        first = false;
        dumpString(key, out);
        *out += ':';
        dumpValue(value, out);
      }
      *out += '}';
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP (libcurl)
// ---------------------------------------------------------------------------

struct HttpResponse {
  long status = 0;
  std::string body;
  std::string error;
};

size_t writeCallback(char* ptr, size_t size, size_t nmemb, void* userdata) {
  auto* body = static_cast<std::string*>(userdata);
  body->append(ptr, size * nmemb);
  return size * nmemb;
}

// GET when jsonBody is empty, POST JSON otherwise. Always sends the bearer.
HttpResponse httpRequest(const std::string& url, const std::string& bearer,
                         const std::string& jsonBody) {
  HttpResponse out;
  CURL* curl = curl_easy_init();
  if (!curl) {
    out.error = "curl init failed";
    return out;
  }
  std::string auth = "Authorization: Bearer " + bearer;
  struct curl_slist* headers = nullptr;
  headers = curl_slist_append(headers, auth.c_str());
  if (!jsonBody.empty()) {
    headers = curl_slist_append(headers, "Content-Type: application/json");
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, jsonBody.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)jsonBody.size());
  }
  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeCallback);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &out.body);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 15L);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(curl, CURLOPT_USERAGENT, "zora-presence-worker/1.0");
  curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
  CURLcode rc = curl_easy_perform(curl);
  if (rc != CURLE_OK) {
    out.error = curl_easy_strerror(rc);
  } else {
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &out.status);
  }
  curl_slist_free_all(headers);
  curl_easy_cleanup(curl);
  return out;
}

// ---------------------------------------------------------------------------
// Configuration: process env first, then a .env file in the working directory.
// ---------------------------------------------------------------------------

std::map<std::string, std::string> g_dotenv;

void loadDotenv(const std::string& path) {
  std::ifstream file(path);
  if (!file) return;
  std::string line;
  while (std::getline(file, line)) {
    std::string t = trim(line);
    if (t.empty() || t[0] == '#') continue;
    size_t eq = t.find('=');
    if (eq == std::string::npos) continue;
    std::string key = trim(t.substr(0, eq));
    std::string value = trim(t.substr(eq + 1));
    if (value.size() >= 2 &&
        ((value.front() == '"' && value.back() == '"') ||
         (value.front() == '\'' && value.back() == '\''))) {
      value = value.substr(1, value.size() - 2);
    }
    if (!key.empty()) g_dotenv[key] = value;
  }
}

std::string envOr(const char* name, const std::string& fallback = "") {
  if (const char* v = std::getenv(name); v && *v) return v;
  if (auto it = g_dotenv.find(name); it != g_dotenv.end()) return it->second;
  return fallback;
}

struct Config {
  std::string apiBase;       // ZORA_API_BASE
  std::string secret;        // WORKER_SHARED_SECRET
  std::string discordAppId;  // DISCORD_APP_ID (informational in dry-run mode)
  long long pollIntervalMs = 5000;
};

Config loadConfig() {
  Config cfg;
  cfg.apiBase = envOr("ZORA_API_BASE");
  cfg.secret = envOr("WORKER_SHARED_SECRET");
  cfg.discordAppId = envOr("DISCORD_APP_ID");
  cfg.pollIntervalMs = std::atoll(envOr("POLL_INTERVAL_MS", "5000").c_str());
  if (cfg.pollIntervalMs <= 0) cfg.pollIntervalMs = 5000;
  while (!cfg.apiBase.empty() && cfg.apiBase.back() == '/') cfg.apiBase.pop_back();
  return cfg;
}

// ---------------------------------------------------------------------------
// Discord Social SDK adapter — the ONLY code that touches discordpp.
//
// With the SDK unzipped into third_party/discord_social_sdk/ (see README.md)
// CMake defines ZORA_HAVE_DISCORD_SDK and this block drives real presence.
// Without it, the pool logs what it would push (dry-run) and succeeds, so the
// control plane can be exercised end-to-end with the live API.
//
// The calls below match the actual Social SDK headers (discordpp.h) shipped in
// third_party/discord_social_sdk: Client::UpdateToken + Client::Connect with
// SetStatusChangedCallback, discordpp::Activity built via its Set* methods,
// Client::UpdateRichPresence(activity, callback) and Client::ClearRichPresence().
// ---------------------------------------------------------------------------

constexpr size_t kMaxLoggedJson = 300;

std::string briefJson(const JValue& value) {
  std::string json;
  dumpValue(value, &json);
  if (json.size() > kMaxLoggedJson) json = json.substr(0, kMaxLoggedJson) + "…";
  return json;
}

uint64_t timestampForSdk(double value) {
  // SDK 1.10.19337 accepts Unix milliseconds and also tolerates small Unix
  // second values. The API stores Date.now() values, so preserve them exactly.
  return static_cast<uint64_t>(std::llround(value));
}

#ifdef ZORA_HAVE_DISCORD_SDK

/// One connected Discord client per user. The SDK drives its own websocket;
/// we only feed it tokens and activity updates.
struct DiscordSession {
  discordpp::Client client;
  bool connecting = false;
  bool ready = false;
};

class DiscordPool {
 public:
  bool apply(const std::string& userId, const std::string& token,
             const JValue& activity, std::string* error) {
    DiscordSession& session = sessions_[userId];
    ensureConnected(&session, userId, token);

    // Map the server-validated activity JSON onto the SDK struct using the
    // Activity setters from discordpp.h (partial activity: the SDK fills in
    // name/applicationId itself).
    discordpp::Activity a{};
    if (const JValue* v = activity.find("type"); v && v->type == JValue::Type::Number) {
      a.SetType(static_cast<discordpp::ActivityTypes>(
          std::max(0, std::min(6, (int)std::llround(v->number)))));
    }
    if (const JValue* v = activity.find("details"); v && v->type == JValue::Type::String) {
      a.SetDetails(v->string);
    }
    if (const JValue* v = activity.find("state"); v && v->type == JValue::Type::String) {
      a.SetState(v->string);
    }
    if (const JValue* ts = activity.find("timestamps"); ts && ts->type == JValue::Type::Object) {
      discordpp::ActivityTimestamps stamps{};
      if (const JValue* v = ts->find("start"); v && v->type == JValue::Type::Number) {
        stamps.SetStart(timestampForSdk(v->number));
      }
      if (const JValue* v = ts->find("end"); v && v->type == JValue::Type::Number) {
        stamps.SetEnd(timestampForSdk(v->number));
      }
      a.SetTimestamps(std::move(stamps));
    }
    if (const JValue* assets = activity.find("assets"); assets && assets->type == JValue::Type::Object) {
      discordpp::ActivityAssets art{};
      if (const JValue* v = assets->find("large_image"); v && v->type == JValue::Type::String)
        art.SetLargeImage(v->string);
      if (const JValue* v = assets->find("large_text"); v && v->type == JValue::Type::String)
        art.SetLargeText(v->string);
      if (const JValue* v = assets->find("small_image"); v && v->type == JValue::Type::String)
        art.SetSmallImage(v->string);
      if (const JValue* v = assets->find("small_text"); v && v->type == JValue::Type::String)
        art.SetSmallText(v->string);
      a.SetAssets(std::move(art));
    }
    if (const JValue* party = activity.find("party"); party && party->type == JValue::Type::Object) {
      if (const JValue* size = party->find("size"); size && size->type == JValue::Type::Array &&
                                                   size->array.size() == 2) {
        discordpp::ActivityParty p{};
        p.SetCurrentSize((int32_t)std::llround(size->array[0].number));
        p.SetMaxSize((int32_t)std::llround(size->array[1].number));
        a.SetParty(std::move(p));
      }
    }

    std::atomic<bool> done{false};
    std::string resultError;
    session.client.UpdateRichPresence(std::move(a),
        [&done, &resultError](discordpp::ClientResult result) {
          if (!result.Successful()) resultError = result.ToString();
          done.store(true);
        });
    waitForCallback(&done);
    if (!resultError.empty()) {
      *error = "UpdateRichPresence failed: " + resultError;
      return false;
    }
    return true;
  }

  bool clear(const std::string& userId, const std::string& token, std::string* error) {
    (void)token;
    auto it = sessions_.find(userId);
    if (it == sessions_.end()) return true;  // nothing live
    if (!it->second.ready) {
      // Not connected: nothing was ever applied, and connecting just to clear
      // would leave a dangling client behind.
      return true;
    }
    it->second.client.ClearRichPresence();
    return true;
  }

 private:
  void ensureConnected(DiscordSession* session, const std::string& userId,
                       const std::string& token) {
    if (session->ready || session->connecting) return;
    session->connecting = true;

    session->client.SetStatusChangedCallback(
        [session, userId](discordpp::Client::Status status, discordpp::Client::Error error,
                          int32_t errorDetail) {
          if (status == discordpp::Client::Status::Ready) {
            session->ready = true;
            logLine("[discord] gateway ready for user " + userId);
          } else if (status == discordpp::Client::Status::Disconnected ||
                     status == discordpp::Client::Status::Disconnecting) {
            session->ready = false;
            session->connecting = false;
            if (error != discordpp::Client::Error::None) {
              logLine("[discord] gateway dropped for user " + userId + ": " +
                      discordpp::Client::ErrorToString(error) + " detail=" +
                      std::to_string(errorDetail));
            }
          }
        });

    // OAuth2 bearer token from the Zora API (scope includes the Social SDK
    // presence scope — see README "Known risks"). Bearer is the only token
    // type the SDK accepts for this flow.
    std::atomic<bool> tokenDone{false};
    std::string tokenError;
    session->client.UpdateToken(discordpp::AuthorizationTokenType::Bearer, token,
        [&tokenDone, &tokenError](discordpp::ClientResult result) {
          if (!result.Successful()) tokenError = result.ToString();
          tokenDone.store(true);
        });
    waitForCallback(&tokenDone);
    if (!tokenError.empty()) {
      session->connecting = false;
      throw std::runtime_error("UpdateToken failed for user " + userId + ": " + tokenError);
    }
    session->client.Connect();
    logLine("[discord] connecting gateway for user " + userId);

    // Connect and all SDK callbacks are asynchronous. Pump the SDK event queue
    // while waiting so the following presence update is not sent too early.
    for (int i = 0; i < 300 && !session->ready; ++i) {
      discordpp::RunCallbacks();
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    session->connecting = false;
    if (!session->ready) {
      throw std::runtime_error("Discord SDK connection timed out for user " + userId);
    }
  }

  /// UpdateRichPresence/UpdateToken complete asynchronously on the SDK's own
  /// threads; block briefly for the callback so the reconcile pass sees the
  /// real result.
  static void waitForCallback(std::atomic<bool>* done) {
    for (int i = 0; i < 100 && !done->load(); ++i) {
      discordpp::RunCallbacks();
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
  }

  std::map<std::string, DiscordSession> sessions_;
};

#else  // dry-run build (no Social SDK present)

class DiscordPool {
 public:
  bool apply(const std::string& userId, const std::string& token,
             const JValue& activity, std::string* error) {
    (void)token;
    (void)error;
    logLine("[dry-run] apply user=" + userId + " activity=" + briefJson(activity));
    return true;
  }

  bool clear(const std::string& userId, const std::string& token, std::string* error) {
    (void)token;
    (void)error;
    logLine("[dry-run] clear user=" + userId);
    return true;
  }
};

#endif  // ZORA_HAVE_DISCORD_SDK

// ---------------------------------------------------------------------------
// Worker loop
// ---------------------------------------------------------------------------

struct SessionState {
  long long revision = -1;                 // forces an apply on first sight
  std::string desiredState;
  std::string appliedActivityJson;         // "" = nothing currently applied
};

class Worker {
 public:
  explicit Worker(Config cfg) : cfg_(std::move(cfg)) {}

  // One poll → reconcile → heartbeat pass. Throws on poll/transport errors.
  void pollOnce() {
    HttpResponse res = httpRequest(cfg_.apiBase + "/api/public/worker/poll", cfg_.secret, "");
    if (!res.error.empty()) throw std::runtime_error(std::string("poll: ") + res.error);
    if (res.status == 401) {
      throw std::runtime_error("poll: 401 Unauthorized — WORKER_SHARED_SECRET mismatch");
    }
    if (res.status / 100 != 2) {
      throw std::runtime_error("poll: HTTP " + std::to_string(res.status));
    }

    JValue payload;
    std::string err;
    if (!JsonParser(res.body).parse(&payload, &err)) {
      throw std::runtime_error("poll: bad JSON: " + err);
    }
    const JValue* list = payload.find("sessions");
    if (!list || list->type != JValue::Type::Array) return;
    for (const JValue& session : list->array) {
      reconcile(session);
    }
  }

 private:
  void reconcile(const JValue& session) {
    const JValue* idVal = session.find("discord_user_id");
    if (!idVal || idVal->type != JValue::Type::String || idVal->string.empty()) return;
    const std::string userId = idVal->string;

    long long revision = 0;
    if (const JValue* rev = session.find("revision"); rev && rev->type == JValue::Type::Number) {
      revision = (long long)std::llround(rev->number);
    }

    bool running = false;
    if (const JValue* d = session.find("desired_state"); d && d->type == JValue::Type::String) {
      running = d->string == "running";
    }

    std::string token;
    if (const JValue* t = session.find("access_token"); t && t->type == JValue::Type::String) {
      token = t->string;
    }

    const JValue* activity = session.find("activity");
    std::string activityJson = "null";
    if (activity && activity->type != JValue::Type::Null) {
      dumpValue(*activity, &activityJson);
    }

    SessionState& prev = sessions_[userId];

    std::string state;
    std::string message;

    if (running) {
      if (revision != prev.revision || prev.appliedActivityJson != activityJson) {
        std::string error;
        try {
          if (discord_.apply(userId, token, activity ? *activity : JValue{}, &error)) {
            state = "running";
            prev.appliedActivityJson = activityJson;
          } else {
            state = "error";
            message = error.substr(0, 400);
          }
        } catch (const std::exception& e) {
          state = "error";
          message = std::string(e.what()).substr(0, 400);
        }
      } else {
        state = "running";  // unchanged — heartbeat keeps liveness
      }
    } else if (!prev.appliedActivityJson.empty()) {
      std::string error;
      try {
        if (discord_.clear(userId, token, &error)) {
          state = "cleared";
          prev.appliedActivityJson.clear();
        } else {
          state = "error";
          message = error.substr(0, 400);
        }
      } catch (const std::exception& e) {
        state = "error";
        message = std::string(e.what()).substr(0, 400);
      }
    } else {
      state = "cleared";  // nothing applied — nothing to clear
    }

    prev.revision = revision;
    prev.desiredState = running ? "running" : "stopped";

    sendHeartbeat(userId, state, message, revision);
    logLine("[session] " + userId + " desired=" + (running ? "running" : "stopped") +
            " → " + state + (message.empty() ? "" : " (" + message + ")") +
            " rev=" + std::to_string(revision));
  }

  void sendHeartbeat(const std::string& userId, const std::string& state,
                     const std::string& message, long long revision) {
    JValue body;
    body.type = JValue::Type::Object;
    JValue id;
    id.type = JValue::Type::String;
    id.string = userId;
    body.object["discord_user_id"] = std::move(id);
    JValue st;
    st.type = JValue::Type::String;
    st.string = state;
    body.object["state"] = std::move(st);
    JValue msg;
    if (message.empty()) {
      msg.type = JValue::Type::Null;
    } else {
      msg.type = JValue::Type::String;
      msg.string = message;
    }
    body.object["message"] = std::move(msg);
    JValue rev;
    rev.type = JValue::Type::Number;
    rev.number = (double)revision;
    rev.isInt = true;
    body.object["revision"] = std::move(rev);

    std::string json;
    dumpValue(body, &json);
    HttpResponse res =
        httpRequest(cfg_.apiBase + "/api/public/worker/heartbeat", cfg_.secret, json);
    if (!res.error.empty() || res.status / 100 != 2) {
      logLine("[heartbeat] failed for " + userId + ": " +
              (res.error.empty() ? ("HTTP " + std::to_string(res.status)) : res.error));
    }
  }

  Config cfg_;
  DiscordPool discord_;
  std::map<std::string, SessionState> sessions_;
};

}  // namespace

int main() {
  loadDotenv(".env");
  Config cfg = loadConfig();
  if (cfg.apiBase.empty() || cfg.secret.empty()) {
    logLine("ZORA_API_BASE and WORKER_SHARED_SECRET are required (env or .env). "
            "See worker/README.md.");
    return 1;
  }

#ifdef ZORA_HAVE_DISCORD_SDK
  logLine("zora-presence-worker: Social SDK mode, app id " + cfg.discordAppId);
#else
  logLine("zora-presence-worker: DRY-RUN mode (no Social SDK) — presence "
          "updates are logged, not pushed. See worker/README.md.");
#endif
  logLine("polling " + cfg.apiBase + "/api/public/worker/poll every " +
          std::to_string(cfg.pollIntervalMs) + "ms");

  curl_global_init(CURL_GLOBAL_DEFAULT);
  Worker worker(std::move(cfg));
  while (true) {
#ifdef ZORA_HAVE_DISCORD_SDK
    // The Social SDK delivers status and operation callbacks through this
    // pump; keep it running even during polls with no activity changes.
    discordpp::RunCallbacks();
#endif
    try {
      worker.pollOnce();
    } catch (const std::exception& e) {
      logLine(std::string("poll failed: ") + e.what());
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(cfg.pollIntervalMs));
  }
}
