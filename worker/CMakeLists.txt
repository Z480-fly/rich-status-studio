cmake_minimum_required(VERSION 3.16)
project(zora_presence_worker CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Discord Social SDK — download it from the Discord Developer Portal and unzip
# into worker/third_party/discord_social_sdk (see README.md). Not redistributable.
set(DISCORD_SDK "${CMAKE_CURRENT_SOURCE_DIR}/third_party/discord_social_sdk")

if(NOT EXISTS "${DISCORD_SDK}/include/discordpp.h")
  message(FATAL_ERROR
    "Discord Social SDK not found at ${DISCORD_SDK}. See worker/README.md.")
endif()

find_package(CURL REQUIRED)

add_executable(zora-presence-worker src/main.cpp)
target_include_directories(zora-presence-worker PRIVATE "${DISCORD_SDK}/include")
target_link_libraries(zora-presence-worker PRIVATE
  CURL::libcurl
  "${DISCORD_SDK}/lib/release/libdiscord_partner_sdk.so")
set_target_properties(zora-presence-worker PROPERTIES
  BUILD_RPATH "${DISCORD_SDK}/lib/release"
  INSTALL_RPATH "$ORIGIN/lib")
