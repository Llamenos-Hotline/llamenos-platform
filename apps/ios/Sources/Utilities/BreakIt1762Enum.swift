import Foundation

// #1762 break-it verification — THROWAWAY, never merge.
// Deliberately assumes two status enums that read as "the same status" are
// one shared generated type (the #1754 shape). They are not: quicktype only
// unifies string enums with identical member sets, so an active call's
// status (SharedActiveCallResponseStatus: completed / in-progress /
// ringing) is NOT the conversation/report status
// (SharedReportResponseStatus: active / waiting / closed). This assignment
// must NOT compile.
enum BreakIt1762Enum {
    static func reportStatus(fromCallStatus status: SharedActiveCallResponseStatus?) -> SharedReportResponseStatus? {
        status
    }
}
