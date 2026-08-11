#include "util.h"

int util_value() {
#if defined(FIRST_DB)
  return 10;
#elif defined(SECOND_DB)
  return 20;
#else
  return 42;
#endif
}
