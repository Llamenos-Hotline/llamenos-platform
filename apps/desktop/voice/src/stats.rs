//! Audio-stream counters for the Tier 2 harness (examples/sip_e2e.rs) only —
//! the measurement half of "two-way audio, measured, not mocked".

use llamenos_voice_sys::ffi;

use crate::MediaPath;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AudioStats {
    /// The ICE pair carrying the stream.
    pub media_path: Option<MediaPath>,
    /// Current receive / send bandwidth, kbit/s.
    pub download_kbps: f32,
    pub upload_kbps: f32,
    /// RTP packets actually received on the stream since it started.
    pub rtp_packets_received: u64,
    pub rtp_packets_sent: u64,
}

pub(crate) unsafe fn audio_stats(call: *mut ffi::LinphoneCall) -> Option<AudioStats> {
    let stats = ffi::linphone_call_get_audio_stats(call);
    if stats.is_null() {
        return None;
    }
    let rtp = ffi::linphone_call_stats_get_rtp_stats(stats);
    let (received, sent) = if rtp.is_null() {
        (0, 0)
    } else {
        ((*rtp).packet_recv, (*rtp).packet_sent)
    };
    let out = AudioStats {
        media_path: match ffi::linphone_call_stats_get_ice_state(stats) {
            ffi::LinphoneIceState::LinphoneIceStateHostConnection => Some(MediaPath::Host),
            ffi::LinphoneIceState::LinphoneIceStateReflexiveConnection => {
                Some(MediaPath::Reflexive)
            }
            ffi::LinphoneIceState::LinphoneIceStateRelayConnection => Some(MediaPath::Relay),
            _ => None,
        },
        download_kbps: ffi::linphone_call_stats_get_download_bandwidth(stats),
        upload_kbps: ffi::linphone_call_stats_get_upload_bandwidth(stats),
        rtp_packets_received: received,
        rtp_packets_sent: sent,
    };
    ffi::linphone_call_stats_unref(stats);
    Some(out)
}
