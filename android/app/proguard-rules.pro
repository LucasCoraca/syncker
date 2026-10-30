# bare-kit's native code calls back into its Java classes by name (IPC, Worklet).
-keep class to.holepunch.bare.** { *; }
-keepclasseswithmembernames class * { native <methods>; }
