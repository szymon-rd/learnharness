// The test macros of C++ code cells (deploy/cpp). Each test runs in its own
// process: the first failed check prints a report and exits with status 1.
#pragma once
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <sstream>
#include <string>

namespace lh_test {

template <class T>
concept Printable = requires(std::ostream& o, const T& v) { o << v; };

template <class T>
std::string show(const T& v) {
	if constexpr (Printable<T>) {
		std::ostringstream s;
		s << std::boolalpha << v;
		return s.str();
	} else {
		return "(a value that cannot be printed)";
	}
}

[[noreturn]] inline void fail(const std::string& what, const std::string& detail) {
	std::cout << std::flush;
	std::cout << "\n@@LH_FAIL\n" << what << detail << "\n@@LH_END" << std::endl;
	std::exit(1);
}

}  // namespace lh_test

#define CHECK(cond)                                                     \
	do {                                                                \
		if (!(cond)) ::lh_test::fail("CHECK(" #cond ") is false", ""); \
	} while (0)

#define CHECK_EQ(actual, expected)                                                                      \
	do {                                                                                                \
		const auto& lh_a = (actual);                                                                    \
		const auto& lh_e = (expected);                                                                  \
		if (!(lh_a == lh_e))                                                                            \
			::lh_test::fail("CHECK_EQ(" #actual ", " #expected ") failed",                            \
			                "\n  got:      " + ::lh_test::show(lh_a) + "\n  expected: " + ::lh_test::show(lh_e)); \
	} while (0)

#define CHECK_NEAR(actual, expected, eps)                                                               \
	do {                                                                                                \
		const double lh_a = (actual);                                                                   \
		const double lh_e = (expected);                                                                 \
		if (!(std::fabs(lh_a - lh_e) <= (eps)))                                                         \
			::lh_test::fail("CHECK_NEAR(" #actual ", " #expected ", " #eps ") failed",                \
			                "\n  got:      " + ::lh_test::show(lh_a) + "\n  expected: " + ::lh_test::show(lh_e)); \
	} while (0)
