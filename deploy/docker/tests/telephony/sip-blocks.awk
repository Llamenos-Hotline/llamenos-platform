# One SIP message per record, from Asterisk's own pjsip log.
#
# A message block starts at a "<--- Received/Transmitting … --->" marker and
# runs until the NEXT marker. It deliberately does NOT end at a blank line:
# SIP puts one between the headers and the SDP body, so stopping there
# truncates every message that carries media — which is every message this is
# used to read.
#
#   awk -v dir="to TLS:" -v want="200 OK" -v also="m=audio" -f sip-blocks.awk log
#
#   dir   substring the marker must contain ("to TLS:", "from TLS:")
#   want  substring the block must contain
#   also  a second substring the block must contain (optional, default any)
#
# Prints every matching block; exits non-zero when none matched, so a caller
# can tell "no such message" from "an empty one".
function flush() {
  if (buf != "" && buf ~ want && buf ~ also) { printf "%s", buf; found++ }
  buf = ""
}
/^<--- / { flush(); keep = ($0 ~ dir); if (!keep) next }
keep { buf = buf $0 "\n" }
END { flush(); exit(found ? 0 : 1) }
