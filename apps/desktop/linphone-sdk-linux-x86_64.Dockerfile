# syntax=docker/dockerfile:1
#
# Pinned build of the linux-x86_64 liblinphone desktop SDK (#1770, plan Task 1).
#
# Upstream publishes no Linux SDK (see apps/desktop/linphone-sdk-checksums.txt),
# so the operator chose (#1770, 2026-11-24, spike Decision 1 option (a)) to build
# linphone-sdk 5.5.39 ONCE, locally, from this file, and pin the resulting
# tarball by sha256 like the two upstream targets. CI never builds liblinphone
# (spec §3.1); CI fetches the pinned tarball through scripts/fetch-linphone-sdk.sh.
#
# Anyone can rebuild and compare digests:
#
#   scripts/build-linphone-sdk-linux.sh      # prints the sha256 of the tarball
#
# Everything an input could drift on is pinned here:
#   - the base image by digest (not by tag);
#   - the Ubuntu archive by snapshot date (apt resolves exactly the package
#     versions that existed at that instant; apt still verifies signatures);
#   - the linphone-sdk source by tag AND commit (the build refuses a tag that
#     has moved), with every submodule at the commit the tag records.
#
# The base is Ubuntu 22.04 on purpose: the Linux desktop release builds on
# ubuntu-22.04 (.github/workflows/tauri-release.yml), and a library linked on a
# newer glibc would refuse to load there.
#
# ALSA and PulseAudio are REQUIRED, not best-effort. mediastreamer2 silently
# FORCEs ENABLE_ALSA/ENABLE_PULSEAUDIO to OFF when it cannot find the headers
# (mediastreamer2/CMakeLists.txt) — that is exactly how upstream's Python wheel
# shipped with no sound card. This build checks the configured cache AND the
# linked library's NEEDED entries, and fails if either backend is missing.

ARG BASE=ubuntu:jammy-20251013@sha256:104ae83764a5119017b8e8d6218fa0832b09df65aae7d5a6de29a85d813da2fb

FROM ${BASE} AS deps
ARG UBUNTU_SNAPSHOT=20251101T000000Z
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8
# snapshot.ubuntu.com redirects to https, so the CA bundle comes first, from
# the base image's own archive; every package (ca-certificates included) is then
# resolved again from the snapshot. apt verifies the archive signature either
# way — TLS verification is never turned off.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && sed -i \
      -e "s|http://archive.ubuntu.com/ubuntu/\?|https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/|g" \
      -e "s|http://security.ubuntu.com/ubuntu/\?|https://snapshot.ubuntu.com/ubuntu/${UBUNTU_SNAPSHOT}/|g" \
      /etc/apt/sources.list \
 && rm -rf /var/lib/apt/lists/* \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git cmake ninja-build make g++ gcc nasm yasm perl pkg-config \
      python3 python3-pystache python3-six python3-jsonschema python3-jinja2 \
      libasound2-dev libpulse-dev libudev-dev \
      binutils file patchelf \
 && rm -rf /var/lib/apt/lists/* \
 && dpkg-query -W -f '${Package} ${Version}\n' | sort > /build-packages.txt

FROM deps AS source
ARG LINPHONE_SDK_VERSION=5.5.39
ARG LINPHONE_SDK_COMMIT=4d00285c92511acbeba7b2c7c9c621599192584f
RUN git clone --quiet --depth 1 --branch "${LINPHONE_SDK_VERSION}" \
      https://gitlab.linphone.org/BC/public/linphone-sdk.git /src \
 && cd /src \
 && actual="$(git rev-parse HEAD)" \
 && if [ "$actual" != "${LINPHONE_SDK_COMMIT}" ]; then \
      echo "tag ${LINPHONE_SDK_VERSION} resolves to $actual, pinned ${LINPHONE_SDK_COMMIT} — refusing" >&2; exit 1; \
    fi \
 && git -c advice.detachedHead=false submodule update --init --recursive --depth 1 --jobs 8 \
 && git submodule status --recursive > /src-submodules.txt \
 && if grep -qE '^[-+U]' /src-submodules.txt; then \
      echo "submodules not at the commits the tag records:" >&2; grep -E '^[-+U]' /src-submodules.txt >&2; exit 1; \
    fi

FROM source AS configure
# Upstream CI's own debian12 audio-only configuration (-DENABLE_VIDEO=OFF
# -DENABLE_LDAP=OFF, .gitlab-ci-files/linux-desktop/linux-desktop-debian12.yml),
# minus docs and test helpers. ENABLE_RELATIVE_PREFIX makes liblinphone and
# mediastreamer2 find their resources (belr grammars, plugins, sounds) relative
# to the library, so the SDK works from wherever the desktop bundle puts it.
RUN cmake -S /src -B /build -G Ninja \
      -DCMAKE_BUILD_TYPE=RelWithDebInfo \
      -DCMAKE_INSTALL_PREFIX=/opt/linphone-sdk \
      -DCMAKE_INSTALL_LIBDIR=lib \
      -DCMAKE_INSTALL_RPATH='$ORIGIN' \
      -DENABLE_VIDEO=OFF \
      -DENABLE_LDAP=OFF \
      -DENABLE_DOC=OFF \
      -DENABLE_UNIT_TESTS=OFF \
      -DENABLE_TESTS_COMPONENT=OFF \
      -DENABLE_RELATIVE_PREFIX=ON \
      -DENABLE_ALSA=ON \
      -DENABLE_PULSEAUDIO=ON \
      -DENABLE_SRTP=ON \
 && for opt in ENABLE_ALSA ENABLE_PULSEAUDIO ENABLE_SRTP ENABLE_MBEDTLS; do \
      grep -qx "${opt}:BOOL=ON" /build/CMakeCache.txt \
        || { echo "configure dropped ${opt} (see CMakeCache.txt) — refusing" >&2; grep "^${opt}:" /build/CMakeCache.txt >&2; exit 1; }; \
    done

# The build is split into layers so a long compile resumes from cache instead of
# starting over (each layer is a strict prefix of the next one's work).
FROM configure AS build-media
RUN cmake --build /build --target mediastreamer2

FROM build-media AS build-sip
RUN cmake --build /build --target belle-sip

FROM build-sip AS build-all
RUN cmake --build /build

FROM build-all AS package
ARG LINPHONE_SDK_VERSION=5.5.39
RUN cmake --install /build \
 && cd /opt/linphone-sdk \
 && test -f include/linphone/core.h \
 && test -f lib/liblinphone.so \
 && test -d share/belr/grammars \
 && ms2="$(readlink -f lib/libmediastreamer2.so)" \
 && readelf -d "$ms2" | grep -q 'NEEDED.*libasound\.so' \
      || { echo "libmediastreamer2 does not link ALSA — refusing" >&2; exit 1; } \
 && readelf -d "$ms2" | grep -q 'NEEDED.*libpulse\.so' \
      || { echo "libmediastreamer2 does not link PulseAudio — refusing" >&2; exit 1; } \
 && find lib -name '*.so*' -type f -exec strip --strip-debug {} + \
 && cp /build-packages.txt /src-submodules.txt . \
 && printf '%s\n' "${LINPHONE_SDK_VERSION}" > VERSION
# A deterministic tarball: sorted entries, fixed mtime/owner, gzip without a
# name or timestamp. Layout: linphone-sdk/linux-x86_64/{include,lib,share,...}.
RUN mkdir -p /stage/linphone-sdk /out \
 && cp -a /opt/linphone-sdk /stage/linphone-sdk/linux-x86_64 \
 && tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
      -C /stage -cf - linphone-sdk \
    | gzip -9n > "/out/linphone-sdk-linux-x86_64-${LINPHONE_SDK_VERSION}.tar.gz" \
 && sha256sum /out/*.tar.gz

FROM scratch AS artifact
COPY --from=package /out/ /
