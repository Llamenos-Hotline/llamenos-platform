/* Narrow bindgen surface (spec §3.1). build.rs allowlists only linphone_*,
 * Linphone* types/vars and the bctbx_list_* helpers needed to walk the lists
 * liblinphone returns; nothing else from these headers is bound. */
#include <linphone/core.h>
#include <linphone/factory.h>
#include <linphone/logging.h>
