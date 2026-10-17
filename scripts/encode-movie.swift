// Encode a directory of transparent PNG frames into a QuickTime movie that
// keeps the alpha channel, with AVFoundation.
//
//   encode-movie <frame-dir> <out.mov> <fps> <prores4444|hevc-alpha>
//   encode-movie --probe <movie.mov>
//
// The browser cannot write video with alpha (its WebCodecs encoders here do
// H.264 only, and WebM would not play in Keynote anyway), so the page renders
// the frames and the dev server hands them to this program. ProRes 4444 is
// the format every editor and Keynote take with transparency; HEVC with alpha
// is a tenth of the size and plays on Apple platforms.
//
// --probe opens a movie and reports what an editor would see: the codec,
// whether the track says it carries alpha, and the alpha of a corner pixel
// and of the most opaque pixel in the last frame - so an export can be
// checked without eyeballing it over a checkerboard.

import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import VideoToolbox

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

let args = CommandLine.arguments

if args.count == 3 && args[1] == "--probe" {
    probe(URL(fileURLWithPath: args[2]))
    exit(0)
}

guard args.count == 5, let fps = Int32(args[3]), fps > 0 else {
    fail("usage: encode-movie <frame-dir> <out.mov> <fps> <prores4444|hevc-alpha>", 64)
}

let dir = URL(fileURLWithPath: args[1])
let out = URL(fileURLWithPath: args[2])
let codec: AVVideoCodecType
switch args[4] {
case "prores4444": codec = .proRes4444
case "hevc-alpha": codec = .hevcWithAlpha
default: fail("unknown codec \(args[4]) - prores4444 or hevc-alpha", 64)
}

let frames = ((try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [])
    .filter { $0.pathExtension.lowercased() == "png" }
    .sorted { $0.lastPathComponent < $1.lastPathComponent }
guard let firstURL = frames.first else { fail("no PNG frames in \(dir.path)", 65) }

func loadImage(_ url: URL) -> CGImage? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(source, 0, nil)
}

guard let first = loadImage(firstURL) else { fail("cannot read \(firstURL.lastPathComponent)", 65) }
let width = first.width, height = first.height

try? FileManager.default.removeItem(at: out)
let writer: AVAssetWriter
do { writer = try AVAssetWriter(outputURL: out, fileType: .mov) } catch { fail("cannot create \(out.path): \(error)", 73) }

// The frames are sRGB from a canvas; tag the movie as Rec. 709, which is what
// editors assume for HD video and is near enough for near-black ink.
var settings: [String: Any] = [
    AVVideoCodecKey: codec,
    AVVideoWidthKey: width,
    AVVideoHeightKey: height,
    AVVideoColorPropertiesKey: [
        AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
        AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
        AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
    ],
]
if codec == .hevcWithAlpha {
    settings[AVVideoCompressionPropertiesKey] = [
        AVVideoQualityKey: 0.9,
        kVTCompressionPropertyKey_TargetQualityForAlpha as String: 0.95,
    ]
}

let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(
    assetWriterInput: input,
    sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height,
    ]
)
guard writer.canAdd(input) else { fail("this machine cannot write \(args[4]) at \(width)x\(height)", 69) }
writer.add(input)
guard writer.startWriting() else { fail("cannot start writing: \(writer.error?.localizedDescription ?? "?")", 70) }
writer.startSession(atSourceTime: .zero)

let space = CGColorSpace(name: CGColorSpace.sRGB)!
// BGRA with premultiplied alpha is what a CVPixelBuffer of this format holds
let bitmapInfo = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue

for (index, url) in frames.enumerated() {
    guard let image = index == 0 ? first : loadImage(url) else { fail("cannot read \(url.lastPathComponent)", 65) }
    guard image.width == width, image.height == height else {
        fail("\(url.lastPathComponent) is \(image.width)x\(image.height), not \(width)x\(height)", 65)
    }
    while !input.isReadyForMoreMediaData { usleep(2000) }
    var buffer: CVPixelBuffer?
    guard let pool = adaptor.pixelBufferPool,
          CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess,
          let pixels = buffer else { fail("no pixel buffer", 70) }
    CVPixelBufferLockBaseAddress(pixels, [])
    guard let context = CGContext(
        data: CVPixelBufferGetBaseAddress(pixels), width: width, height: height,
        bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pixels),
        space: space, bitmapInfo: bitmapInfo
    ) else { fail("no drawing context", 70) }
    let rect = CGRect(x: 0, y: 0, width: width, height: height)
    context.clear(rect) // a pooled buffer holds the previous frame
    context.draw(image, in: rect)
    CVPixelBufferUnlockBaseAddress(pixels, [])
    if !adaptor.append(pixels, withPresentationTime: CMTime(value: CMTimeValue(index), timescale: fps)) {
        fail("frame \(index) refused: \(writer.error?.localizedDescription ?? "?")", 70)
    }
}

input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
guard writer.status == .completed else { fail("writing failed: \(writer.error?.localizedDescription ?? "?")", 70) }
print("\(frames.count) frames, \(width)x\(height), \(fps) fps, \(args[4]) -> \(out.path)")

// ---------------------------------------------------------------- probe --

func probe(_ url: URL) {
    let asset = AVURLAsset(url: url)
    let semaphore = DispatchSemaphore(value: 0)
    Task {
        defer { semaphore.signal() }
        do {
            guard let track = try await asset.loadTracks(withMediaType: .video).first else {
                print("no video track"); return
            }
            let duration = try await asset.load(.duration)
            let formats = try await track.load(.formatDescriptions)
            let size = try await track.load(.naturalSize)
            var codecName = "?", flagsAlpha = false
            if let format = formats.first {
                let fourCC = CMFormatDescriptionGetMediaSubType(format)
                codecName = String([24, 16, 8, 0].map { Character(UnicodeScalar(UInt8((fourCC >> $0) & 0xff))) })
                if let extensions = CMFormatDescriptionGetExtensions(format) as? [String: Any] {
                    flagsAlpha = (extensions[kCMFormatDescriptionExtension_ContainsAlphaChannel as String] as? Bool) ?? false
                    if let depth = extensions[kCMFormatDescriptionExtension_Depth as String] as? Int, depth == 32 { flagsAlpha = true }
                }
            }
            print("codec \(codecName), \(Int(size.width))x\(Int(size.height)), \(String(format: "%.2f", duration.seconds)) s, track says alpha: \(flagsAlpha)")

            // read the last frame back and look at its alpha directly
            let generator = AVAssetImageGenerator(asset: asset)
            generator.requestedTimeToleranceBefore = .zero
            generator.requestedTimeToleranceAfter = .zero
            let time = CMTime(seconds: max(0, duration.seconds - 0.02), preferredTimescale: 600)
            let (image, _) = try await generator.image(at: time)
            let w = image.width, h = image.height
            var raw = [UInt8](repeating: 0, count: w * h * 4)
            let context = CGContext(data: &raw, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                    space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            var transparent = 0, opaque = 0, maxAlpha: UInt8 = 0
            for i in stride(from: 3, to: raw.count, by: 4) {
                let a = raw[i]
                if a == 0 { transparent += 1 } else if a == 255 { opaque += 1 }
                if a > maxAlpha { maxAlpha = a }
            }
            let total = w * h
            print("last frame: corner alpha \(raw[3]), max alpha \(maxAlpha), " +
                  "\(100 * transparent / total)% fully transparent, \(100 * opaque / total)% fully opaque")
        } catch {
            print("probe failed: \(error)")
        }
    }
    semaphore.wait()
}
