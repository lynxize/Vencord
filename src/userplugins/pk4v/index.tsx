/* eslint-disable */
import definePlugin, { OptionType } from "@utils/types";
import { definePluginSettings } from "@api/Settings";
import PKAPI from "pkapi.js";
import { Message, User } from "discord-types/general";
import { ChannelStore, MessageActions, MessageStore } from "@webpack/common";
import { addButton, removeButton } from "@api/MessagePopover";
import { addPreEditListener, addPreSendListener, removePreEditListener } from "@api/MessageEvents";


// some of this is inspired by a similar plugin by Scyye
// and also cobbled together from the rest of the vencord plugins
// (I'm very much not a JS/TS frontend dev)

// known issues
// - pk edit button appears for all pk proxied messages
// - pk edit button doesn't quite match normal discord
// - up arrow to edit most recent message doesn't work

const EditIcon = () => {
    return <svg role="img" width="18" height="18" fill="none" viewBox="0 0 24 24">
        <path fill="currentColor" d="m13.96 5.46 4.58 4.58a1 1 0 0 0 1.42 0l1.38-1.38a2 2 0 0 0 0-2.82l-3.18-3.18a2 2 0 0 0-2.82 0l-1.38 1.38a1 1 0 0 0 0 1.42ZM2.11 20.16l.73-4.22a3 3 0 0 1 .83-1.61l7.87-7.87a1 1 0 0 1 1.42 0l4.58 4.58a1 1 0 0 1 0 1.42l-7.87 7.87a3 3 0 0 1-1.6.83l-4.23.73a1.5 1.5 0 0 1-1.73-1.73Z"></path>
    </svg>;
};

const settings = definePluginSettings({
    token: {
        description: "PluralKit Token",
        type: OptionType.STRING,
    },
    colorMode: {
        description: "Color Mode",
        type: OptionType.SELECT,
        options: [
            { label: "Color by account role color", value: "Account", default: true },
            { label: "Color by member color", value: "Member" },
            { label: "Color by system color", value: "System"},
            { label: "No color", value: "None"}
        ]
    }
});

var pk = new PKAPI({});


export default definePlugin({
    settings,
    name: "PluralKit Integration",
    description: "Makes PluralKit less painful to use",
    authors: [
        {
            id: 951258605615718410n,
            name: "Lynxize"
        }
    ],
    patches: [
        {
            // from showMeYourName plugin
            find: ".useCanSeeRemixBadge)",
            replacement: {
                match: /(?<=onContextMenu:\i,children:).*?\)}/,
                replace: "$self.renderUsername(arguments[0])}"
            }
        }
    ],

    renderUsername: ({
        author,
        m,
        isRepliedMessage,
        withMentionPrefix,
        userOverride
    }) => {
        if (!author.hasOwnProperty("clan")) return <span style={{color: "#0000ff"}}>{author?.nick}</span>;
        else return <>{author?.nick}</>
    },

    start() {
        addButton("PkEdit", msg => {
            // this doesn't check if its *your* pk message
            // not sure how to avoid that without running into pk api ratelimiting issues
            if (!msg || !isPkProxiedMessage(msg.channel_id, msg.id)) return null;

            const handleClick = () => MessageActions.startEditMessage(msg.channel_id, msg.id, msg.content);

            return {
                label: "Edit (PK)",
                icon: EditIcon,
                message: msg,
                channel: ChannelStore.getChannel(msg.channel_id),
                onClick: handleClick,
                onContextMenu: _ => {}
            };
        });

        this.preEditListener = addPreEditListener((channelId, messageId, messageObj) => {
            if (isPkProxiedMessage(channelId, messageId)) {
                const guild_id = ChannelStore.getChannel(channelId).guild_id;
                MessageActions.sendMessage(channelId, {
                    reaction: false,
                    content: "pk;e https://discord.com/channels/" + guild_id + "/" + channelId + "/" + messageId + " " + messageObj.content
                })
                //return {cancel: true}
                // note that presumably we're sending off invalid edit requests, hopefully that doesn't cause issues
            }
        })
    },

    stop() {
        removeButton("PkEdit");
        removePreEditListener(this.preEditListener);
    }
});


function isPkProxiedMessage(channelId: string, messageId: string): boolean {
    const msg =  MessageStore.getMessage(channelId, messageId); // monosodium glutamate
    return msg.applicationId === "466378653216014359" && msg.webhookId != undefined
}
