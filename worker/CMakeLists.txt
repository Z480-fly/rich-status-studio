cmake_minimum_required(VERSION 3.16)
project(zora_presence_worker CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Discord Social SDK is a gated, non-redistributable download. Keep it out of
# source control. Override this cache variable when the SDK is staged elsewhere.
set(DISCORD_SDK_ROOT
    "${CMAKE_CURRENT_SOURCE_DIR}/third_party/discord_social_sdk"
    CACHE PATH "Root of the extracted Discord Social SDK")

find_package(CURL REQUIRED)

add_executable(zora-presence-worker src/main.cpp)
target_link_libraries(zora-presence-worker PRIVATE CURL::libcurl)

find_path(DISCORD_SDK_INCLUDE_DIR
  NAMES discordpp.h
  PATHS "${DISCORD_SDK_ROOT}/include"
  NO_DEFAULT_PATH)
find_library(DISCORD_SDK_LIBRARY
  NAMES discord_partner_sdk
  PATHS
    "${DISCORD_SDK_ROOT}/lib/release"
    "${DISCORD_SDK_ROOT}/lib"
  NO_DEFAULT_PATH)

if(DISCORD_SDK_INCLUDE_DIR AND DISCORD_SDK_LIBRARY)
  get_filename_component(DISCORD_SDK_LIBRARY_DIR
    "${DISCORD_SDK_LIBRARY}" DIRECTORY)
  target_compile_definitions(zora-presence-worker PRIVATE ZORA_HAVE_DISCORD_SDK)
  target_include_directories(zora-presence-worker PRIVATE "${DISCORD_SDK_INCLUDE_DIR}")
  # ALSA is a transitive dependency of the SDK's audio subsystem on Linux.
  find_library(ALSA_LIBRARY asound)
  if(NOT ALSA_LIBRARY)
    message(FATAL_ERROR
      "Discord Social SDK requires libasound2 (ALSA). "
      "Install it with: sudo apt install libasound2-dev")
  endif()
  target_link_libraries(zora-presence-worker PRIVATE
    "${DISCORD_SDK_LIBRARY}" "${ALSA_LIBRARY}")
  set_target_properties(zora-presence-worker PROPERTIES
    BUILD_RPATH "${DISCORD_SDK_LIBRARY_DIR}"
    INSTALL_RPATH "$ORIGIN")
  # Keep the runtime layout self-contained without copying proprietary SDK
  # files into the repository or a distributable source archive.
  add_custom_command(TARGET zora-presence-worker POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${DISCORD_SDK_LIBRARY}"
      "$<TARGET_FILE_DIR:zora-presence-worker>/libdiscord_partner_sdk.so")
  message(STATUS "Discord Social SDK enabled: ${DISCORD_SDK_LIBRARY}")
elseif(NOT DISCORD_SDK_INCLUDE_DIR AND NOT DISCORD_SDK_LIBRARY)
  message(STATUS
    "Discord Social SDK not found at ${DISCORD_SDK_ROOT} — building the dry-run "
    "control-plane binary (logs presence updates instead of pushing them). "
    "See worker/README.md.")
else()
  message(FATAL_ERROR
    "Incomplete Discord Social SDK at ${DISCORD_SDK_ROOT}: expected both "
    "include/discordpp.h and lib/release/libdiscord_partner_sdk.so (or lib/).")
endif()
