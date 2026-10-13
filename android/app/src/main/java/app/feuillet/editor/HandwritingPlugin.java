package app.feuillet.editor;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.tasks.Task;
import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.common.model.DownloadConditions;
import com.google.mlkit.common.model.RemoteModelManager;
import com.google.mlkit.vision.digitalink.DigitalInkRecognition;
import com.google.mlkit.vision.digitalink.DigitalInkRecognitionModel;
import com.google.mlkit.vision.digitalink.DigitalInkRecognitionModelIdentifier;
import com.google.mlkit.vision.digitalink.DigitalInkRecognizer;
import com.google.mlkit.vision.digitalink.DigitalInkRecognizerOptions;
import com.google.mlkit.vision.digitalink.Ink;
import com.google.mlkit.vision.digitalink.RecognitionCandidate;
import com.google.mlkit.vision.digitalink.RecognitionContext;
import com.google.mlkit.vision.digitalink.RecognitionResult;
import com.google.mlkit.vision.digitalink.WritingArea;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;

/**
 * Écriture → texte sur Android avec ML Kit Digital Ink (le moteur d'écriture manuscrite de
 * Google, celui du clavier Gboard) : entraîné sur de vraies écritures, hors ligne une fois le
 * modèle de la langue téléchargé (≈ 20 Mo, une seule fois).
 */
@CapacitorPlugin(name = "Handwriting")
public class HandwritingPlugin extends Plugin {
    private DigitalInkRecognizer recognizer;
    private DigitalInkRecognitionModel model;
    private String lang;

    private DigitalInkRecognitionModel modelFor(String tag) throws Exception {
        if (model != null && tag.equals(lang)) return model;
        DigitalInkRecognitionModelIdentifier id = DigitalInkRecognitionModelIdentifier.fromLanguageTag(tag);
        if (id == null) throw new Exception("Langue non prise en charge : " + tag);
        if (recognizer != null) recognizer.close();
        model = DigitalInkRecognitionModel.builder(id).build();
        recognizer = DigitalInkRecognition.getClient(DigitalInkRecognizerOptions.builder(model).build());
        lang = tag;
        return model;
    }

    /** Le modèle est-il déjà sur l'appareil ? (sinon la première conversion le télécharge) */
    @PluginMethod
    public void status(PluginCall call) {
        try {
            DigitalInkRecognitionModel m = modelFor(call.getString("lang", "fr"));
            RemoteModelManager.getInstance().isModelDownloaded(m)
                .addOnSuccessListener(ok -> {
                    JSObject r = new JSObject();
                    r.put("available", true);
                    r.put("downloaded", ok);
                    call.resolve(r);
                })
                .addOnFailureListener(e -> call.reject(e.getMessage()));
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /**
     * lines : [ligne][trait][point] = [x, y] ; renvoie pour chaque ligne les propositions
     * { text, score } (la meilleure en tête).
     */
    @PluginMethod
    public void recognize(PluginCall call) {
        final DigitalInkRecognitionModel m;
        final List<Ink> inks = new ArrayList<>();
        final List<float[]> areas = new ArrayList<>();
        try {
            m = modelFor(call.getString("lang", "fr"));
            JSONArray lines = call.getData().getJSONArray("lines");
            for (int l = 0; l < lines.length(); l++) {
                JSONArray strokes = lines.getJSONArray(l);
                Ink.Builder ink = Ink.builder();
                float x0 = Float.MAX_VALUE, y0 = Float.MAX_VALUE, x1 = -Float.MAX_VALUE, y1 = -Float.MAX_VALUE;
                long t = 0;
                for (int s = 0; s < strokes.length(); s++) {
                    JSONArray pts = strokes.getJSONArray(s);
                    Ink.Stroke.Builder sb = Ink.Stroke.builder();
                    for (int p = 0; p < pts.length(); p++) {
                        JSONArray pt = pts.getJSONArray(p);
                        float x = (float) pt.getDouble(0), y = (float) pt.getDouble(1);
                        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
                        // Horodatage régulier : l'ordre d'écriture est celui des points
                        sb.addPoint(Ink.Point.create(x, y, t += 10));
                    }
                    ink.addStroke(sb.build());
                    t += 150;
                }
                inks.add(ink.build());
                areas.add(new float[] { Math.max(1, x1 - x0), Math.max(1, y1 - y0) });
            }
        } catch (Exception e) {
            call.reject(e.getMessage());
            return;
        }
        RemoteModelManager.getInstance().download(m, new DownloadConditions.Builder().build())
            .addOnFailureListener(e -> call.reject("Modèle d'écriture non téléchargé : " + e.getMessage()))
            .addOnSuccessListener(v -> {
                List<Task<RecognitionResult>> tasks = new ArrayList<>();
                for (int i = 0; i < inks.size(); i++) {
                    float[] a = areas.get(i);
                    // Zone d'écriture : une ligne un peu plus haute que l'écriture, aussi large qu'elle
                    RecognitionContext ctx = RecognitionContext.builder()
                        .setPreContext("")
                        .setWritingArea(new WritingArea(a[0] * 1.1f, a[1] * 1.6f))
                        .build();
                    tasks.add(recognizer.recognize(inks.get(i), ctx));
                }
                Tasks.whenAllSuccess(tasks)
                    .addOnSuccessListener(results -> {
                        JSArray out = new JSArray();
                        for (Object o : results) {
                            JSArray cands = new JSArray();
                            int rank = 0;
                            for (RecognitionCandidate c : ((RecognitionResult) o).getCandidates()) {
                                JSObject j = new JSObject();
                                j.put("text", c.getText());
                                Float score = c.getScore();
                                j.put("score", score != null ? (double) score : (double) rank);
                                j.put("rank", rank++);
                                cands.put(j);
                                if (rank >= 5) break;
                            }
                            out.put(cands);
                        }
                        JSObject r = new JSObject();
                        r.put("results", out);
                        call.resolve(r);
                    })
                    .addOnFailureListener(e -> call.reject(e.getMessage()));
            });
    }
}
