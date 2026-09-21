// Zora presence worker — Linux, Discord Social SDK.
//
// iPhone/browser Zora → HTTPS backend (Zora API) → THIS PROCESS → Discord
// Social SDK → the user's Discord profile.
//
// The worker is the only component that talks to Discord. It:
//   1. polls  GET  /api/public/worker/poll      (Bearer WORKER_SHARED_SECRET)
//   2. starts/updates/clears Rich Presence through the Social SDK, one
//      discordpp::Client per linked Discord account, only when the revision
//      actually changed
//   3. reports POST /api/public/worker/heartbeat so the phone can see whether
//      the presence is live
//
// Build: see ../README.md (cmake + libcurl + the SDK zip from the Developer
// Portal). Run: ./build/zora-presence-worker (reads ./.env).

#define DISCORDPP_IMPLEMENTATION
#include "discordpp.h"

#include <curl/curl.h>

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

// ---------------------------------------------------------------------------
// Minimal JSON — the worker only ever exchanges the fixed control-plane
// payloads from ../README.md, so a small parser keeps the build hermetic
// (no FetchContent / no network at configure time).
// ---------------------------------------------------------------------------

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
        {
          Value v;
          v.t = Value::T::Bool;
          v.b = true;
          return v;
        }
      case 'f':
        if (!literal("false")) fail("bad literal");
        {
          Value v;
          v.t = Value::T::Bool;
          v.b = false;
          return v;
        }
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

/** Escapes a UTF-8 string for use inside a JSON document. */
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

// ---------------------------------------------------------------------------
// .env + config
// ---------------------------------------------------------------------------

namespace {

std::map<std::string, std::string> g_dotEnv;

void loadDotEnv(const std::string& path) {
  std::ifstream file(path);
  if (!file) return;
  std::string line;
  while (std::getline(file, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty() || line[0] == '#') continue;
    const auto eq = line.find('=');
    if (eq == std::string::npos) continue;
    std::string key = line.substr(0, eq);
    std::string value = line.substr(eq + 1);
    const auto trim = [](std::string& s) {
      const auto notSpace = [](unsigned char c) { return !std::isspace(c); };
      s.erase(s.begin(), std::find_if(s.begin(), s.end(), notSpace));
      s.erase(std::find_if(s.rbegin(), s.rend(), notSpace).base(), s.end());
    };
    trim(key);
    trim(value);
    if (value.size() >= 2 && ((value.front() == '"' && value.back() == '"') ||
                              (value.front() == '\'' && value.back() == '\''))) {
      value = value.substr(1, value.size() - 2);
    }
    if (!key.empty() && g_dotEnv.find(key) == g_dotEnv.end()) {
      g_dotEnv[key] = value;  // real environment variables win
    }
  }
}

std::string envOr(const char* key, const std::string& fallback = "") {
  if (const char* v = std::getenv(key)) return v;
  const auto it = g_dotEnv.find(key);
  return it != g_dotEnv.end() ? it->second : fallback;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

void logLine(const std::string& scope, const std::string& message) {
  const auto now = std::chrono::system_clock::now();
  const std::time_t t = std::chrono::system_clock::to_time_t(now);
  std::tm tm{};
  localtime_r(&t, &tm);
  char stamp[32];
  std::strftime(stamp, sizeof(stamp), "%H:%M:%S", &tm);
  std::cout << "[" << stamp << "] [" << scope << "] " << message << std::endl;
}

// ---------------------------------------------------------------------------
// libcurl helpers
// ---------------------------------------------------------------------------

size_t curlWriteCb(char* ptr, size_t size, size_t nmemb, void* userdata) {
  auto* out = static_cast<std::string*>(userdata);
  out->append(ptr, size * nmemb);
  return size * nmemb;
}

std::optional<std::string> httpJson(const std::string& url,
                                    const std::string& bearer,
                                    const std::string* postBody) {
  CURL* curl = curl_easy_init();
  if (!curl) return std::nullopt;
  std::string response;
  std::string auth = "Authorization: Bearer " + bearer;
  struct curl_slist* headers = nullptr;
  headers = curl_slist_append(headers, auth.c_str());
  if (postBody) headers = curl_slist_append(headers, "Content-Type: application/json");

  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curlWriteCb);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT, 20L);
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 10L);
  curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
  if (postBody) curl_easy_setopt(curl, CURLOPT_POSTFIELDS, postBody->c_str());

  const CURLcode rc = curl_easy_perform(curl);
  long status = 0;
  curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
  curl_slist_free_all(headers);
  curl_easy_cleanup(curl);

  if (rc != CURLE_OK) {
    logLine("http", std::string("request failed: ") + curl_easy_strerror(rc));
    return std::nullopt;
  }
  if (status < 200 || status >= 300) {
    logLine("http", "HTTP " + std::to_string(status) + " from " + url + ": " +
                        response.substr(0, 300));
    return std::nullopt;
  }
  return response;
}

}  // namespace

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

namespace {

struct Config {
  std::string apiBase;
  std::string sharedSecret;
  std::string discordAppId;
  long long pollIntervalMs = 5000;
  long long livenessIntervalMs = 30000;
};

std::atomic<bool> g_running{true};

void handleSignal(int) { g_running = false; }

constexpr int kUpdateNone = 0;
constexpr int kUpdatePending = 1;
constexpr int kUpdateApplied = 2;
constexpr int kUpdateFailed = 3;

/** One linked Discord account. SDK callbacks only touch atomics; the map and
 *  all SDK calls live on the main thread. */
struct Session {
  std::string userId;
  std::shared_ptr<discordpp::Client> client;
  std::atomic<bool> ready{false};
  std::atomic<bool> connectFailed{false};
  std::atomic<int> updateState{kUpdateNone};

  // main-thread-only bookkeeping
  std::string token;
  long long revision = -1;
  std::string activityJson;
  long long appliedRevision = -1;
  std::string appliedJson;
  long long lastHeartbeatMs = 0;
  std::string lastHeartbeatState;
};

class Worker {
 public:
  explicit Worker(const Config& config) : cfg_(config) {}

  void run() {
    const auto started = std::chrono::steady_clock::now();
    auto nextPoll = started;
    auto nextLiveness = started + std::chrono::milliseconds(cfg_.livenessIntervalMs);

    logLine("worker", "polling " + cfg_.apiBase + " every " +
                          std::to_string(cfg_.pollIntervalMs) + "ms");

    while (g_running) {
      discordpp::RunCallbacks();

      const auto now = std::chrono::steady_clock::now();
      if (now >= nextPoll) {
        nextPoll = now + std::chrono::milliseconds(cfg_.pollIntervalMs);
        pollOnce();
      }
      if (now >= nextLiveness) {
        nextLiveness = now + std::chrono::milliseconds(cfg_.livenessIntervalMs);
        heartbeatLiveness();
      }

      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }

    logLine("worker", "shutting down, disconnecting clients…");
    for (auto& [userId, session] : sessions_) {
      if (session->client) session->client->Disconnect();
    }
  }

 private:
  Config cfg_;
  std::map<std::string, std::shared_ptr<Session>> sessions_;
  long long monotonicMs_ = 0;

  long long nowMs() const {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
  }

  bool heartbeat(const std::string& userId, const std::string& state,
                 const std::string& message, long long revision) {
    std::string body = "{\"discord_user_id\":\"" + mj::escape(userId) +
                       "\",\"state\":\"" + mj::escape(state) + "\"";
    if (!message.empty()) {
      body += ",\"message\":\"" + mj::escape(message) + "\"";
    }
    body += ",\"revision\":" + std::to_string(revision) + "}";
    const std::string url = cfg_.apiBase + "/api/public/worker/heartbeat";
    const auto res = httpJson(url, cfg_.sharedSecret, &body);
    if (!res) {
      logLine("heartbeat", "failed for " + userId + " (" + state + ")");
      return false;
    }
    return true;
  }

  void pollOnce() {
    const auto res = httpJson(cfg_.apiBase + "/api/public/worker/poll", cfg_.sharedSecret, nullptr);
    if (!res) return;

    mj::Value doc;
    try {
      doc = mj::parse(*res);
    } catch (const std::exception& e) {
      logLine("poll", std::string("bad JSON from API: ") + e.what());
      return;
    }

    const mj::Value* sessionsArr = doc.find("sessions");
    if (!sessionsArr || sessionsArr->t != mj::Value::T::Arr) {
      logLine("poll", "response has no sessions array");
      return;
    }

    monotonicMs_ = nowMs();
    std::map<std::string, bool> seen;

    for (const mj::Value& row : sessionsArr->arr) {
      const std::string userId = row.find("discord_user_id") ? row.find("discord_user_id")->asStr() : "";
      if (userId.empty()) continue;
      seen[userId] = true;

      const std::string desired =
          row.find("desired_state") ? row.find("desired_state")->asStr("stopped") : "stopped";
      const long long revision =
          row.find("revision") ? row.find("revision")->asInt(0) : 0;
      const std::string token =
          row.find("access_token") ? row.find("access_token")->asStr() : "";
      const mj::Value* activity = row.find("activity");
      const std::string activityJson = activity ? serialize(*activity) : "";

      auto it = sessions_.find(userId);
      if (desired != "running") {
        if (it != sessions_.end()) {
          clearSession(it->second);
          sessions_.erase(it);
          heartbeat(userId, "cleared", "", revision);
        }
        continue;
      }

      if (it == sessions_.end()) {
        if (token.empty()) {
          // The API only includes a token when it could refresh one; without
          // it this account will be marked errored server-side already.
          continue;
        }
        auto session = std::make_shared<Session>();
        session->userId = userId;
        session->token = token;
        session->revision = revision;
        session->activityJson = activityJson;
        sessions_[userId] = session;
        connect(session);
        heartbeat(userId, "connecting", "", revision);
        session->lastHeartbeatMs = monotonicMs_;
      } else if (it->second->token != token && !token.empty()) {
        // The server rotated the access token; reconnect with the fresh one.
        auto session = it->second;
        clearSession(session);
        sessions_.erase(it);
        auto fresh = std::make_shared<Session>();
        fresh->userId = userId;
        fresh->token = token;
        fresh->revision = revision;
        fresh->activityJson = activityJson;
        sessions_[userId] = fresh;
        connect(fresh);
        heartbeat(userId, "connecting", "", revision);
        fresh->lastHeartbeatMs = monotonicMs_;
      }
    }

    // Accounts that vanished from the poll (link revoked, errored, deleted):
    // make sure nothing is left connected on the VM.
    for (auto it = sessions_.begin(); it != sessions_.end();) {
      if (!seen.count(it->first)) {
        logLine("worker", "session " + it->first + " disappeared from poll; clearing");
        clearSession(it->second);
        it = sessions_.erase(it);
      } else {
        ++it;
      }
    }

    pumpStateTransitions();
  }

  void connect(const std::shared_ptr<Session>& session) {
    const std::string& userId = session->userId;
    logLine("sdk", "connecting client for " + userId);

    auto client = std::make_shared<discordpp::Client>();
    client->AddLogCallback(
        [userId](auto message, auto severity) {
          if (severity == discordpp::LoggingSeverity::Error) {
            logLine("sdk:" + userId, std::string(message));
          }
        },
        discordpp::LoggingSeverity::Error);

    client->SetStatusChangedCallback(
        [session, userId](discordpp::Client::Status status, discordpp::Client::Error error,
                          int32_t errorDetail) {
          if (status == discordpp::Client::Status::Ready) {
            session->ready = true;
            logLine("sdk:" + userId, "ready");
          } else if (error != discordpp::Client::Error::None) {
            session->connectFailed = true;
            logLine("sdk:" + userId,
                    std::string("connection error: ") +
                        discordpp::Client::ErrorToString(error) + " (" +
                        std::to_string(errorDetail) + ")");
          }
        });

    if (!cfg_.discordAppId.empty()) {
      try {
        client->SetApplicationId(std::stoull(cfg_.discordAppId));
      } catch (const std::exception&) {
        logLine("worker", "DISCORD_APP_ID is not a numeric application id: " +
                              cfg_.discordAppId);
      }
    }

    const std::string token = session->token;
    client->UpdateToken(
        discordpp::AuthorizationTokenType::Bearer, token,
        [client, session, userId](discordpp::ClientResult result) {
          if (result.Successful()) {
            logLine("sdk:" + userId, "token set, connecting…");
            client->Connect();
          } else {
            session->connectFailed = true;
            logLine("sdk:" + userId, "UpdateToken failed");
          }
        });

    session->client = client;
  }

  void clearSession(const std::shared_ptr<Session>& session) {
    if (!session->client) return;
    logLine("sdk", "disconnecting " + session->userId);
    session->client->ClearRichPresence();
    session->client->Disconnect();
    session->client.reset();
    session->ready = false;
  }

  /** Applies pending update results + pushes presence when revisions change. */
  void pumpStateTransitions() {
    for (auto& [userId, session] : sessions_) {
      const int update = session->updateState.load();
      if (update == kUpdateApplied) {
        session->appliedRevision = session->revision;
        session->appliedJson = session->activityJson;
        session->updateState = kUpdateNone;
        heartbeat(userId, "running", "", session->appliedRevision);
        session->lastHeartbeatMs = monotonicMs_;
        session->lastHeartbeatState = "running";
      } else if (update == kUpdateFailed) {
        session->updateState = kUpdateNone;
        heartbeat(userId, "error", "Discord rejected the presence update", session->revision);
        session->lastHeartbeatMs = monotonicMs_;
        session->lastHeartbeatState = "error";
      } else if (session->connectFailed.load()) {
        session->connectFailed = false;
        heartbeat(userId, "error", "Could not connect to Discord with the provided token",
                  session->revision);
        session->lastHeartbeatMs = monotonicMs_;
        session->lastHeartbeatState = "error";
      }

      if (session->ready && session->updateState == kUpdateNone &&
          (session->appliedRevision != session->revision ||
           session->appliedJson != session->activityJson)) {
        applyActivity(session);
      }
    }
  }

  void applyActivity(const std::shared_ptr<Session>& session) {
    mj::Value parsed;
    if (!session->activityJson.empty()) {
      try {
        parsed = mj::parse(session->activityJson);
      } catch (const std::exception& e) {
        logLine("worker", "bad activity JSON for " + session->userId + ": " + e.what());
        return;
      }
    }
    discordpp::Activity activity = buildActivity(parsed, session->userId);
    session->updateState = kUpdatePending;
    logLine("sdk:" + session->userId,
            "UpdateRichPresence (revision " + std::to_string(session->revision) + ")");
    session->client->UpdateRichPresence(
        activity, [session](discordpp::ClientResult result) {
          session->updateState = result.Successful() ? kUpdateApplied : kUpdateFailed;
        });
  }

  /** Periodic "still alive" heartbeat for every running session so the phone
   *  can distinguish a healthy worker from a dead one. */
  void heartbeatLiveness() {
    for (auto& [userId, session] : sessions_) {
      if (!session->ready || session->client == nullptr) continue;
      if (monotonicMs_ - session->lastHeartbeatMs < cfg_.livenessIntervalMs) continue;
      const std::string& state = session->lastHeartbeatState.empty() ? "running" : session->lastHeartbeatState;
      heartbeat(userId, state, "", session->appliedRevision >= 0 ? session->appliedRevision : session->revision);
      session->lastHeartbeatMs = monotonicMs_;
    }
  }

  static std::string serialize(const mj::Value& v) {
    // Round-trips through the parser just to produce a canonical string for
    // equality checks across polls.
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

  /** Maps the stored activity payload (see src/lib/presence.ts) to the SDK. */
  discordpp::Activity buildActivity(const mj::Value& a, const std::string& userId) const {
    discordpp::Activity activity{};
    if (a.t != mj::Value::T::Obj) return activity;

    if (const mj::Value* type = a.find("type"); type && type->t == mj::Value::T::Num) {
      activity.SetType(static_cast<discordpp::ActivityTypes>(
          static_cast<int>(type->num)));
    }
    if (const mj::Value* name = a.find("name"); name && name->isStr()) {
      activity.SetName(name->str);
    }
    if (const mj::Value* details = a.find("details"); details && details->isStr()) {
      activity.SetDetails(details->str);
    }
    if (const mj::Value* state = a.find("state"); state && state->isStr()) {
      activity.SetState(state->str);
    }

    if (const mj::Value* ts = a.find("timestamps"); ts && ts->t == mj::Value::T::Obj) {
      discordpp::ActivityTimestamps timestamps{};
      // The API stores Unix milliseconds; the SDK wants seconds.
      if (const mj::Value* start = ts->find("start"); start && start->t == mj::Value::T::Num) {
        timestamps.SetStart(static_cast<int64_t>(start->num / 1000.0));
      }
      if (const mj::Value* end = ts->find("end"); end && end->t == mj::Value::T::Num) {
        timestamps.SetEnd(static_cast<int64_t>(end->num / 1000.0));
      }
      activity.SetTimestamps(timestamps);
    }

    if (const mj::Value* assets = a.find("assets"); assets && assets->t == mj::Value::T::Obj) {
      discordpp::ActivityAssets sdkAssets{};
      // Public https URLs are passed through directly; Discord also accepts
      // uploaded asset keys here.
      if (const mj::Value* v = assets->find("large_image"); v && v->isStr()) {
        sdkAssets.SetLargeImage(v->str);
      }
      if (const mj::Value* v = assets->find("large_text"); v && v->isStr()) {
        sdkAssets.SetLargeText(v->str);
      }
      if (const mj::Value* v = assets->find("small_image"); v && v->isStr()) {
        sdkAssets.SetSmallImage(v->str);
      }
      if (const mj::Value* v = assets->find("small_text"); v && v->isStr()) {
        sdkAssets.SetSmallText(v->str);
      }
      activity.SetAssets(sdkAssets);
    }

    if (const mj::Value* party = a.find("party"); party && party->t == mj::Value::T::Obj) {
      if (const mj::Value* size = party->find("size");
          size && size->t == mj::Value::T::Arr && size->arr.size() == 2) {
        discordpp::ActivityParty sdkParty{};
        sdkParty.SetId("zora-" + userId);  // stable per account so invites behave
        sdkParty.SetCurrentSize(static_cast<int32_t>(size->arr[0].asInt(0)));
        sdkParty.SetMaxSize(static_cast<int32_t>(size->arr[1].asInt(0)));
        activity.SetParty(sdkParty);
      }
    }

    return activity;
  }
};

}  // namespace

int main() {
  std::signal(SIGINT, handleSignal);
  std::signal(SIGTERM, handleSignal);

  loadDotEnv(".env");

  Config cfg;
  cfg.apiBase = envOr("ZORA_API_BASE");
  cfg.sharedSecret = envOr("WORKER_SHARED_SECRET");
  cfg.discordAppId = envOr("DISCORD_APP_ID");
  cfg.pollIntervalMs = std::atoll(envOr("POLL_INTERVAL_MS", "5000").c_str());
  if (cfg.pollIntervalMs < 1000) cfg.pollIntervalMs = 1000;
  cfg.livenessIntervalMs = std::atoll(envOr("LIVENESS_INTERVAL_MS", "30000").c_str());
  if (cfg.livenessIntervalMs < 5000) cfg.livenessIntervalMs = 5000;

  if (cfg.apiBase.empty() || cfg.sharedSecret.empty()) {
    std::cerr << "zora-presence-worker: ZORA_API_BASE and WORKER_SHARED_SECRET are required "
                 "(see .env.example)"
              << std::endl;
    return 1;
  }
  if (cfg.discordAppId.empty()) {
    logLine("worker", "warning: DISCORD_APP_ID not set; relying on Connect() to bind it");
  }

  if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) {
    std::cerr << "zora-presence-worker: curl_global_init failed" << std::endl;
    return 1;
  }

  logLine("worker", "starting (api " + cfg.apiBase + ", poll " +
                        std::to_string(cfg.pollIntervalMs) + "ms)");

  {
    Worker worker(cfg);
    worker.run();
  }

  curl_global_cleanup();
  logLine("worker", "bye");
  return 0;
}
