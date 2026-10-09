import { announcementParagraphs } from "../lib/announcement-presentation";
import styles from "./announcement-body.module.css";

export function AnnouncementBody({ body, presentation }: { body: string; presentation?: unknown }) {
  return <>{announcementParagraphs(body, presentation).map((paragraph, index) =>
    <p className={`${styles.paragraph}${paragraph.callout ? ` ${styles.callout}` : ""}`} key={index}>
      {paragraph.parts.map((part, partIndex) => part.bold ? <strong key={partIndex}>{part.text}</strong> : part.text)}
    </p>
  )}</>;
}
