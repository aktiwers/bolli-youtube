# A release with Bolli YouTube's own video layer (build.gradle.kts). The shell makes the layer by its name in
# BuildConfig.EXTRA (MainActivity), which R8 cannot see: kept with its constructor. What the web view calls
# (@JavascriptInterface) R8's own rules keep, and Media3's rules come with Media3.
-keep class org.bolli.youtube.NativeVideo {
    public <init>();
}
# (a failure on a TV traced back by R8's name map: mapping.txt, in the build's outputs)
-keepattributes SourceFile,LineNumberTable
