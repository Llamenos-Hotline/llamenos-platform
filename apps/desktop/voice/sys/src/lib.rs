#![allow(
    non_camel_case_types,
    non_snake_case,
    non_upper_case_globals,
    dead_code
)]
#![allow(clippy::all)]
//! Raw bindgen output over the pinned liblinphone C API (#1770, plan Task 2).
//! Unsafe lives here and only here; consumers use the safe `llamenos-voice`
//! wrapper. Nothing else in the repo links liblinphone.

pub mod ffi {
    include!(concat!(env!("OUT_DIR"), "/bindings.rs"));
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_linked_library_answers_its_version() {
        // Proves the vendored artifact links and loads, before any wrapper
        // exists — the bindgen half of spec §9 open question 2.
        let v = unsafe { crate::ffi::linphone_core_get_version() };
        assert!(!v.is_null());
        let s = unsafe { std::ffi::CStr::from_ptr(v) }.to_string_lossy();
        assert!(
            s.chars().next().is_some_and(|c| c.is_ascii_digit()),
            "version string: {s}"
        );
        // The pin is 5.5.39 on every target; a different library on the
        // loader path (a distro liblinphone, say) must not pass as ours.
        assert!(
            s.starts_with("5.5.39"),
            "linked liblinphone {s}, pinned 5.5.39"
        );
    }
}
