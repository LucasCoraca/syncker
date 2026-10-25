package app.syncker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Periodic allow-while-idle alarm: nudges the service to look for peers during Doze. */
class WakeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        SyncService.start(context, Intent(SyncService.ACTION_WAKE))
    }
}
