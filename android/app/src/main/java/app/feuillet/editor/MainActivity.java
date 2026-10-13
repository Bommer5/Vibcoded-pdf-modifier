package app.feuillet.editor;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Écriture → texte avec le moteur de Google (ML Kit Digital Ink)
        registerPlugin(HandwritingPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
